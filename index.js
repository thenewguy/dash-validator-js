// Copyright 2016 Eyevinn Technology. All rights reserved
// Use of this source code is governed by a MIT License
// license that can be found in the LICENSE file.
// Author: Jonas Birme (Eyevinn Technology)
const DashParser = require("./lib/dash_parser.js");
const DashValidatorRunner = require("./lib/dash_validator_runner.js");
const util = require("./lib/util.js");

/**
 * MPEG DASH Validator
 * 
 * A Javascript library that can be used to validate MPEG DASH streams (VOD and Live).
 * Source available on {@link https://github.com/Eyevinn/dash-validator-js GitHub}
 * 
 * @module dash-validator
 */

/**
 * Creates a new Dash Validator object
 * @constructor
 * 
 * @param {string} src URI to MPEG DASH manifest, e.g. http://example.com/example.mpd
 * @returns {DashValidator}
 */
const DashValidator = function constructor(src) {
  this._src = src;
  this._manifest;
  this._base = "";
  this._manifestHeaders;
  this._runner;
};

/**
 * Download and parses MPEG DASH manifest
 * 
 * @returns {Promise} a Promise that resolves when the manifest is downloaded and parsed. 
 */
DashValidator.prototype.load = function load() {
  return new Promise((resolve, reject) => {
    this._base = util.getBaseUrl(this._src) + "/";
    util.requestXml(this._src).then(resp => {
      this._manifestHeaders = resp.headers;

      const parser = new DashParser();
      parser.parse(resp.xml).then((manifest) => {
        this._manifest = manifest;
        this._runner = new DashValidatorRunner(this._manifest, this._manifestHeaders, 10);
        resolve();
      }).catch(reject);
    }).catch(reject);
  });
};

/**
 * @typedef FailedInfo
 * @type {Object}
 * @property {string} uri URI to the segment that failed
 * @property {Object} headers The actual HTTP response headers 
 */

/**
 * @typedef SuccessInfo
 * @type {Object}
 * @property {string} uri URI to the successful segment
 */

/**
 * @typedef SegmentVerifyResult
 * @type {Object}
 * @property {Array.<FailedInfo>} failed An array of all segments that failed
 * @property {Array.<SuccessInfo>} ok An array of all segments that were ok
 */

/**
 * @typedef ManifestVerifyResult
 * @type {Object}
 * @property {boolean} ok True if successful
 * @property {Object} headers The response headers for the manifest request.
 */

/**
 * Verifies that the timestamp of the last segment for a MPEG DASH live-stream
 * does not differ more than 10 seconds (default) from actual time.
 * 
 * This is only applicable for live-streams and for VOD will always return OK
 * 
 * @typedef TimestampResult
 * @type {Object}
 * @property {string} clock "OK" if ok or "BAD" if diff > allowedDiff
 * @property {string} clockOffset The actual diff between last segment and now
 * 
 * @param {number} allowedDiff The allowed diff (in millisec, default is 10000)
 * @returns {Promise.<TimestampResult>} a Promise that resolves when the timing has been checked.
 */
DashValidator.prototype.verifyTimestamps = function verifyTimestamps(allowedDiff) {
  return new Promise((resolve, reject) => {
    const diffCriteria = allowedDiff || 10000;
    const result = {};
    if (this._manifest.type === "static") {
      result.clock = "OK";
    } else {
      const timeAtHead = this._manifest.timeAtHead;
      const d = new Date().getTime();
      if (Math.abs(timeAtHead - d) > diffCriteria) {
        result.clock = "BAD";
        result.clockOffset = Math.abs(timeAtHead - d);
      } else {
        result.clock = "OK";
        result.clockOffset = Math.abs(timeAtHead - d);
      }
    }
    resolve(result);
  });
}

/**
 * Verify that a list of segments can be downloaded and have correct HTTP headers
 * Applicable for both live and VOD.
 * 
 * @param {Function(Object)} verifyFn Function that is called to verify a segment.
 *    If not provided a default will be used
 * @param {Array.<string>} segments An array of segment URIs
 * @param {boolean} doDownload When true use GET instead of HEAD
 * @returns {Promise.<SegmentVerifyResult>} a Promise that resolves when all segments are verified.
 */
DashValidator.prototype.verifySegments = function verifySegments(verifyFn, segments, doDownload) {
  return new Promise((resolve, reject) => {
    let failed = [];
    let ok = [];
  
    let it = util.iteratorFromArray(segments);
    const base = this._base;

    function checkSegment(doneCb) {
      const iter = it.next();
      if (iter.done) {
        doneCb();
      } else {
        const segmentUrl = iter.value;
        verifySegment(verifyFn || defaultVerifyFn, base + segmentUrl, doDownload).then((result) => {
          if (result.ok) {
            ok.push({ uri: segmentUrl });
          } else {
            failed.push({ uri: segmentUrl, reason: result.reason, headers: result.headers });
          }
          util.sleep(50);
          checkSegment(doneCb);
        }).catch((error) => {
          console.error(error);
        });
      }
    }

    checkSegment(() => {
      resolve({ failed: failed, ok: ok});
    });
  });
};

/**
 * Verify that the manifest is ok.
 * 
 * @param {Function(headers, type)} verifyFn Function that is called to verify a manifest.
 *   If not provided a default will be used.
 * @returns {Promise.<ManifestVerifyResult>} a Promise that resolves when the manifest
 *   is verified.
 */
DashValidator.prototype.verifyManifest = function verifyManifest(verifyFn) {
  return new Promise((resolve, reject) => {
    const verify = verifyFn || defaultManifestVerifyFn;
    const result = {};
    result.ok = verify(this._manifestHeaders, this._manifest.type);
    result.headers = this._manifestHeaders;
    resolve(result);
  });
};

/**
 * Verify that all segments referred to by this MPEG DASH manifest is OK
 * 
 * @param {Function(Object)} verifyFn Function that is called to verify a segment.
 *    If not provided a default will be used
 * @param {boolean} doDownload When true use GET instead of HEAD
 * @returns {Promise.<SegmentVerifyResult>} a Promise that resolves when all segments are verified.
 */
DashValidator.prototype.verifyAllSegments = function verifyAllSegments(verifyFn, doDownload) {
  const segments = this._manifest.segments;
  return this.verifySegments(verifyFn, segments, doDownload);
};

/**
 * Verify a random sample of segments (spotcheck)
 *  
 * @param {Function(Object)} verifyFn Function that is called to verify a segment.
 *    If not provided a default will be used
 * @param {number} noSamples The number of spotchecks to do
 * @param {boolean} doDownload When true use GET instead of HEAD
 * @returns {Promise.<SegmentVerifyResult>} a Promise that resolves when all segments are verified.
 */
DashValidator.prototype.spotcheckSegments = function spotcheckSegments(verifyFn, noSamples, doDownload) {
  const segments = this._manifest.segments;
  let i = 0;
  let spotchecks = [];
  while(i < noSamples) {
    spotchecks.push(util.getRandomItem(segments));
    i++;
  }
  return this.verifySegments(verifyFn, spotchecks, doDownload);
}

/**
 * Validate a dynamically updated MPEG DASH manifest usually used for live
 * streaming
 * 
 * @param {number} iterations Number of iterations to test
 * @param {Function} _optIterator For testing purposes
 * @returns {Promise}
 */
DashValidator.prototype.validateDynamicManifest = function validateDynamicManifest(iterations, _optIterator) {
  return new Promise((resolve, reject) => {
    this._runner.start(iterations, () => {
      return new Promise((resolveUpdateMpd) => {
        // Download, parse and update MPD
        util.requestXml(this._src).then(resp => {
          const parser = new DashParser();
          parser.parse(resp.xml).then((manifest) => {
            this._manifest = manifest;
            this._runner.updateMpd(this._manifest, resp.headers);
            resolveUpdateMpd();
          })
        });
      });
    }, _optIterator)
    .then((result) => {
      resolve(result);
    }).catch(reject);
  });
};

DashValidator.prototype.on = function on(eventName, fn) {
  if (["invalidplayhead", "invalidheaders", "checking"].indexOf(eventName) != -1) {
    this._runner.on(eventName, fn);
  }
};

/**
 * @returns {number} the total duration of the MPEG DASH manifest
 */
DashValidator.prototype.duration = function duration() {
  return this._manifest.totalDuration;
};

/**
 * @returns {Array.<string>} an array with all segment URIs referred to by this
 *   MPEG DASH manifest
 */
DashValidator.prototype.segmentUrls = function segmentUrls() {
  return this._manifest.segments;
};

/**
 * @returns {boolean} True if dynamic manifest, i.e. live stream
 */
DashValidator.prototype.isLive = function isLive() {
  return (this._manifest.type === "dynamic");
};

/** Private functions */

/** @private */
function defaultVerifyFn(headers) {
  let headersOk = true;
  if (typeof headers["cache-control"] === "undefined" ||
      headers["access-control-expose-headers"].split(',').indexOf("Date") == -1 ||
      headers["access-control-allow-headers"].split(',').indexOf("origin") == -1)
  {
    headersOk = false;
  }
  return headersOk;
}

function defaultManifestVerifyFn(headers, type) {
  if (type == "dynamic") {
    if (!headers["cache-control"]) {
      return false;
    }
    const m = headers["cache-control"].match(/max-age=(\d+)/);
    if (!m) {
      return false;
    }
    if (m[1] > 10) {
      // Max age for dynamic manifest should not cache this long
      return false;
    }
  }
  return true;
}

function verifySegment(verifyFn, segmentUrl, doDownload) {
  return new Promise((resolve, reject) => {
    const result = {};

    let reqFn;
    if (!doDownload) {
      reqFn = util.requestHeaders;
    } else {
      reqFn = util.requestCacheFill;
    }
    reqFn(segmentUrl).then((headers) => {
      result.ok = verifyFn(headers);
      result.headers = headers;
      resolve(result);
    }).catch((err) => {
      result.ok = false;
      result.reason = err;
      resolve(result);
    });
  });
}

/** Create a Dash Validator object */
module.exports = DashValidator;
