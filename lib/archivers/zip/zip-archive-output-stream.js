/**
 * node-compress-commons
 *
 * Copyright (c) 2014 Chris Talkington, contributors.
 * Licensed under the MIT license.
 * https://github.com/archiverjs/node-compress-commons/blob/master/LICENSE-MIT
 */
var inherits = require('util').inherits;
var crc32 = require('buffer-crc32');
var {CRC32Stream} = require('crc32-stream');
var {DeflateCRC32Stream} = require('crc32-stream');

var ArchiveOutputStream = require('../archive-output-stream');
var ZipArchiveEntry = require('./zip-archive-entry');
var GeneralPurposeBit = require('./general-purpose-bit');

var constants = require('./constants');
var util = require('../../util');
var zipUtil = require('./util');

var ZipArchiveOutputStream = module.exports = function(options) {
  if (!(this instanceof ZipArchiveOutputStream)) {
    return new ZipArchiveOutputStream(options);
  }

  options = this.options = this._defaults(options);

  ArchiveOutputStream.call(this, options);

  this._entry = null;
  this._entries = [];
  this._archive = {
    centralLength: 0,
    centralOffset: 0,
    comment: '',
    finish: false,
    finished: false,
    processing: false,
    forceZip64: options.forceZip64,
    forceLocalTime: options.forceLocalTime
  };
};

inherits(ZipArchiveOutputStream, ArchiveOutputStream);

ZipArchiveOutputStream.prototype._afterAppend = function(ae) {
  this._entries.push(ae);

  if (ae.getGeneralPurposeBit().usesDataDescriptor()) {
    this._writeDataDescriptor(ae);
  }

  this._archive.processing = false;
  this._entry = null;

  if (this._archive.finish && !this._archive.finished) {
    this._finishAsync();
  }
};

ZipArchiveOutputStream.prototype._appendBuffer = function(ae, source, callback) {
  if (source.length === 0) {
    ae.setMethod(constants.METHOD_STORED);
  }

  var method = ae.getMethod();

  if (method === constants.METHOD_STORED) {
    ae.setSize(source.length);
    ae.setCompressedSize(source.length);
    ae.setCrc(crc32.unsigned(source));
  }

  this._writeLocalFileHeader(ae);

  if (method === constants.METHOD_STORED) {
    this.write(source);
    this._afterAppend(ae);
    callback(null, ae);
    return;
  } else if (method === constants.METHOD_DEFLATED) {
    this._smartStream(ae, callback).end(source);
    return;
  } else {
    callback(new Error('compression method ' + method + ' not implemented'));
    return;
  }
};

ZipArchiveOutputStream.prototype._appendStream = function(ae, source, callback) {
  ae.getGeneralPurposeBit().useDataDescriptor(true);
  ae.setVersionNeededToExtract(constants.MIN_VERSION_DATA_DESCRIPTOR);

  this._writeLocalFileHeader(ae);

  var smart = this._smartStream(ae, callback);
  source.once('error', function(err) {
    smart.emit('error', err);
    smart.end();
  })
  source.pipe(smart);
};

ZipArchiveOutputStream.prototype._defaults = function(o) {
  if (typeof o !== 'object') {
    o = {};
  }

  if (typeof o.zlib !== 'object') {
    o.zlib = {};
  }

  if (typeof o.zlib.level !== 'number') {
    o.zlib.level = constants.ZLIB_BEST_SPEED;
  }

  o.forceZip64 = !!o.forceZip64;
  o.forceLocalTime = !!o.forceLocalTime;

  return o;
};

ZipArchiveOutputStream.prototype._finishAsync = async function() {
  this._archive.centralOffset = this.offset;

  for (const ae of this._entries) {
    await this._writeCentralFileHeaderAsync(ae);
  }

  this._archive.centralLength = this.offset - this._archive.centralOffset;

  if (this.isZip64()) {
    await this._writeCentralDirectoryZip64Async();
  }

  await this._writeCentralDirectoryEndAsync();

  this._archive.processing = false;
  this._archive.finish = true;
  this._archive.finished = true;
  this.end();
};

ZipArchiveOutputStream.prototype._normalizeEntry = function(ae) {
  if (ae.getMethod() === -1) {
    ae.setMethod(constants.METHOD_DEFLATED);
  }

  if (ae.getMethod() === constants.METHOD_DEFLATED) {
    ae.getGeneralPurposeBit().useDataDescriptor(true);
    ae.setVersionNeededToExtract(constants.MIN_VERSION_DATA_DESCRIPTOR);
  }

  if (ae.getTime() === -1) {
    ae.setTime(new Date(), this._archive.forceLocalTime);
  }

  ae._offsets = {
    file: 0,
    data: 0,
    contents: 0,
  };
};

ZipArchiveOutputStream.prototype._smartStream = function(ae, callback) {
  var deflate = ae.getMethod() === constants.METHOD_DEFLATED;
  var process = deflate ? new DeflateCRC32Stream(this.options.zlib) : new CRC32Stream();
  var error = null;

  function handleStuff() {
    var digest = process.digest().readUInt32BE(0);
    ae.setCrc(digest);
    ae.setSize(process.size());
    ae.setCompressedSize(process.size(true));
    this._afterAppend(ae);
    callback(error, ae);
  }

  process.once('end', handleStuff.bind(this));
  process.once('error', function(err) {
    error = err;
  });

  process.pipe(this, { end: false });

  return process;
};

ZipArchiveOutputStream.prototype._writeCentralDirectoryEndAsync = async function() {
  var records = this._entries.length;
  var size = this._archive.centralLength;
  var offset = this._archive.centralOffset;

  if (this.isZip64()) {
    records = constants.ZIP64_MAGIC_SHORT;
    size = constants.ZIP64_MAGIC;
    offset = constants.ZIP64_MAGIC;
  }

  // signature
  await this.writeAsync(zipUtil.getLongBytes(constants.SIG_EOCD));

  // disk numbers
  await this.writeAsync(constants.SHORT_ZERO);
  await this.writeAsync(constants.SHORT_ZERO);

  // number of entries
  await this.writeAsync(zipUtil.getShortBytes(records));
  await this.writeAsync(zipUtil.getShortBytes(records));

  // length and location of CD
  await this.writeAsync(zipUtil.getLongBytes(size));
  await this.writeAsync(zipUtil.getLongBytes(offset));

  // archive comment
  var comment = this.getComment();
  var commentLength = Buffer.byteLength(comment);
  await this.writeAsync(zipUtil.getShortBytes(commentLength));
  await this.writeAsync(comment);
};

ZipArchiveOutputStream.prototype._writeCentralDirectoryZip64Async = async function() {
  // signature
  await this.writeAsync(zipUtil.getLongBytes(constants.SIG_ZIP64_EOCD));

  // size of the ZIP64 EOCD record
  await this.writeAsync(zipUtil.getEightBytes(44));

  // version made by
  await this.writeAsync(zipUtil.getShortBytes(constants.MIN_VERSION_ZIP64));

  // version to extract
  await this.writeAsync(zipUtil.getShortBytes(constants.MIN_VERSION_ZIP64));

  // disk numbers
  await this.writeAsync(constants.LONG_ZERO);
  await this.writeAsync(constants.LONG_ZERO);

  // number of entries
  await this.writeAsync(zipUtil.getEightBytes(this._entries.length));
  await this.writeAsync(zipUtil.getEightBytes(this._entries.length));

  // length and location of CD
  await this.writeAsync(zipUtil.getEightBytes(this._archive.centralLength));
  await this.writeAsync(zipUtil.getEightBytes(this._archive.centralOffset));

  // extensible data sector
  // not implemented at this time

  // end of central directory locator
  await this.writeAsync(zipUtil.getLongBytes(constants.SIG_ZIP64_EOCD_LOC));

  // disk number holding the ZIP64 EOCD record
  await this.writeAsync(constants.LONG_ZERO);

  // relative offset of the ZIP64 EOCD record
  await this.writeAsync(zipUtil.getEightBytes(this._archive.centralOffset + this._archive.centralLength));

  // total number of disks
  await this.writeAsync(zipUtil.getLongBytes(1));
};

ZipArchiveOutputStream.prototype._writeCentralFileHeaderAsync = async function(ae) {
  var gpb = ae.getGeneralPurposeBit();
  var method = ae.getMethod();
  var offsets = ae._offsets;

  var size = ae.getSize();
  var compressedSize = ae.getCompressedSize();

  if (ae.isZip64() || offsets.file > constants.ZIP64_MAGIC) {
    size = constants.ZIP64_MAGIC;
    compressedSize = constants.ZIP64_MAGIC;

    ae.setVersionNeededToExtract(constants.MIN_VERSION_ZIP64);

    var extraBuf = Buffer.concat([
      zipUtil.getShortBytes(constants.ZIP64_EXTRA_ID),
      zipUtil.getShortBytes(24),
      zipUtil.getEightBytes(ae.getSize()),
      zipUtil.getEightBytes(ae.getCompressedSize()),
      zipUtil.getEightBytes(offsets.file)
    ], 28);

    ae.setExtra(extraBuf);
  }

  // signature
  await this.writeAsync(zipUtil.getLongBytes(constants.SIG_CFH));

  // version made by
  await this.writeAsync(zipUtil.getShortBytes((ae.getPlatform() << 8) | constants.VERSION_MADEBY));

  // version to extract and general bit flag
  await this.writeAsync(zipUtil.getShortBytes(ae.getVersionNeededToExtract()));
  await this.writeAsync(gpb.encode());

  // compression method
  await this.writeAsync(zipUtil.getShortBytes(method));

  // datetime
  await this.writeAsync(zipUtil.getLongBytes(ae.getTimeDos()));

  // crc32 checksum
  await this.writeAsync(zipUtil.getLongBytes(ae.getCrc()));

  // sizes
  await this.writeAsync(zipUtil.getLongBytes(compressedSize));
  await this.writeAsync(zipUtil.getLongBytes(size));

  var name = ae.getName();
  var comment = ae.getComment();
  var extra = ae.getCentralDirectoryExtra();

  if (gpb.usesUTF8ForNames()) {
    name = Buffer.from(name);
    comment = Buffer.from(comment);
  }

  // name length
  await this.writeAsync(zipUtil.getShortBytes(name.length));

  // extra length
  await this.writeAsync(zipUtil.getShortBytes(extra.length));

  // comments length
  await this.writeAsync(zipUtil.getShortBytes(comment.length));

  // disk number start
  await this.writeAsync(constants.SHORT_ZERO);

  // internal attributes
  await this.writeAsync(zipUtil.getShortBytes(ae.getInternalAttributes()));

  // external attributes
  await this.writeAsync(zipUtil.getLongBytes(ae.getExternalAttributes()));

  // relative offset of LFH
  if (offsets.file > constants.ZIP64_MAGIC) {
    await this.writeAsync(zipUtil.getLongBytes(constants.ZIP64_MAGIC));
  } else {
    await this.writeAsync(zipUtil.getLongBytes(offsets.file));
  }

  // name
  await this.writeAsync(name);

  // extra
  await this.writeAsync(extra);

  // comment
  await this.writeAsync(comment);
};

ZipArchiveOutputStream.prototype._writeDataDescriptor = function(ae) {
  // signature
  this.write(zipUtil.getLongBytes(constants.SIG_DD));

  // crc32 checksum
  this.write(zipUtil.getLongBytes(ae.getCrc()));

  // sizes
  if (ae.isZip64()) {
    this.write(zipUtil.getEightBytes(ae.getCompressedSize()));
    this.write(zipUtil.getEightBytes(ae.getSize()));
  } else {
    this.write(zipUtil.getLongBytes(ae.getCompressedSize()));
    this.write(zipUtil.getLongBytes(ae.getSize()));
  }
};

ZipArchiveOutputStream.prototype._writeLocalFileHeader = function(ae) {
  var gpb = ae.getGeneralPurposeBit();
  var method = ae.getMethod();
  var name = ae.getName();
  var extra = ae.getLocalFileDataExtra();

  if (ae.isZip64()) {
    gpb.useDataDescriptor(true);
    ae.setVersionNeededToExtract(constants.MIN_VERSION_ZIP64);
  }

  if (gpb.usesUTF8ForNames()) {
    name = Buffer.from(name);
  }

  ae._offsets.file = this.offset;

  // signature
  this.write(zipUtil.getLongBytes(constants.SIG_LFH));

  // version to extract and general bit flag
  this.write(zipUtil.getShortBytes(ae.getVersionNeededToExtract()));
  this.write(gpb.encode());

  // compression method
  this.write(zipUtil.getShortBytes(method));

  // datetime
  this.write(zipUtil.getLongBytes(ae.getTimeDos()));

  ae._offsets.data = this.offset;

  // crc32 checksum and sizes
  if (gpb.usesDataDescriptor()) {
    this.write(constants.LONG_ZERO);
    this.write(constants.LONG_ZERO);
    this.write(constants.LONG_ZERO);
  } else {
    this.write(zipUtil.getLongBytes(ae.getCrc()));
    this.write(zipUtil.getLongBytes(ae.getCompressedSize()));
    this.write(zipUtil.getLongBytes(ae.getSize()));
  }

  // name length
  this.write(zipUtil.getShortBytes(name.length));

  // extra length
  this.write(zipUtil.getShortBytes(extra.length));

  // name
  this.write(name);

  // extra
  this.write(extra);

  ae._offsets.contents = this.offset;
};

ZipArchiveOutputStream.prototype.getComment = function(comment) {
  return this._archive.comment !== null ? this._archive.comment : '';
};

ZipArchiveOutputStream.prototype.isZip64 = function() {
  return this._archive.forceZip64 || this._entries.length > constants.ZIP64_MAGIC_SHORT || this._archive.centralLength > constants.ZIP64_MAGIC || this._archive.centralOffset > constants.ZIP64_MAGIC;
};

ZipArchiveOutputStream.prototype.setComment = function(comment) {
  this._archive.comment = comment;
};
