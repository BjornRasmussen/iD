
import _filter from 'lodash-es/filter';
import _find from 'lodash-es/find';
import _flatten from 'lodash-es/flatten';
import _forEach from 'lodash-es/forEach';
import _isEmpty from 'lodash-es/isEmpty';
import _map from 'lodash-es/map';
import _some from 'lodash-es/some';
import _union from 'lodash-es/union';

import { range as d3_range } from 'd3-array';
import { dispatch as d3_dispatch } from 'd3-dispatch';

import {
    request as d3_request,
    json as d3_json
} from 'd3-request';

import {
    select as d3_select,
    selectAll as d3_selectAll
} from 'd3-selection';

import rbush from 'rbush';

import { jsonpRequest } from '../util/jsonp_request';
import { d3geoTile as d3_geoTile } from '../lib/d3.geo.tile';
import { geoExtent } from '../geo';
import { utilDetect } from '../util/detect';
import { utilQsString, utilRebind } from '../util';

//import _pannellum from 'pannellum';

var apibase = 'https://a.mapillary.com/v3/',
    msapi = 'https://dev.virtualearth.net/mapcontrol/HumanScaleServices/',
    bubbleapi = 'https://t.ssl.ak.tiles.virtualearth.net/tiles/',
    appkey = 'An-VWpS-o_m7aV8Lxa0oR9cC3bxwdhdCYEGEFHMP9wyMbmRJFzWfMDD1z3-DXUuE',
    streetsideViewerCss = 'pannellum-streetside/pannellum.css',
    streetsideViewer = 'pannellum-streetside/pannellum.js',
    viewercss = 'mapillary-js/mapillary.min.css',
    viewerjs = 'mapillary-js/mapillary.js',
    clientId = 'NzNRM2otQkR2SHJzaXJmNmdQWVQ0dzo1ZWYyMmYwNjdmNDdlNmVi',
    maxResults = 1000,
    tileZoom = 14,
    dispatch = d3_dispatch('loadedImages', 'loadedSigns'),
    _mlyFallback = false,
    _mlyCache,
    _mlyClicks,
    _mlySelectedImage,
    _mlySignDefs,
    _mlySignSprite,
    _mlyViewer;


function abortRequest(i) {
    i.abort();
}


function nearNullIsland(x, y, z) {
    if (z >= 7) {
        var center = Math.pow(2, z - 1),
            width = Math.pow(2, z - 6),
            min = center - (width / 2),
            max = center + (width / 2) - 1;
        return x >= min && x <= max && y >= min && y <= max;
    }
    return false;
}


function maxPageAtZoom(z) {
    if (z < 15) return 2;
    if (z === 15) return 5;
    if (z === 16) return 10;
    if (z === 17) return 20;
    if (z === 18) return 40;
    if (z > 18) return 80;
}


function localeTimestamp(s) {
    if (!s) return null;
    var detected = utilDetect();
    var options = {
        day: 'numeric', month: 'short', year: 'numeric'
        //hour: 'numeric', minute: 'numeric', second: 'numeric',
        //timeZone: 'UTC'
    };
    var d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleString(detected.locale, options);
}

// using d3.geo.tiles.js from lib, gets tile extents for the current
// map view extent
function getTiles(projection) {
    //console.log('services - streetside - getTiles()');
    var s = projection.scale() * 2 * Math.PI,
        z = Math.max(Math.log(s) / Math.log(2) - 8, 0),
        ts = 256 * Math.pow(2, z - tileZoom),
        origin = [
            s / 2 - projection.translate()[0],
            s / 2 - projection.translate()[1]];

    return d3_geoTile()
        .scaleExtent([tileZoom, tileZoom])
        .scale(s)
        .size(projection.clipExtent()[1])
        .translate(projection.translate())()
        .map(function (tile) {
            var x = tile[0] * ts - origin[0],
                y = tile[1] * ts - origin[1];

            return {
                id: tile.toString(),
                xyz: tile,
                extent: geoExtent(
                    projection.invert([x, y + ts]),
                    projection.invert([x + ts, y])
                )
            };
        });
}


function loadTiles(which, url, projection) {
    console.log('services - streetside - loadTiles() for: ', which);
    ////console.log("loading tiles from streetside service...");
    var s = projection.scale() * 2 * Math.PI,
        currZoom = Math.floor(Math.max(Math.log(s) / Math.log(2) - 8, 0));
    ////console.log("     var projection = ", projection);
    ////console.log("     var s = ", s);

    // breakup the map view into tiles
    var tiles = getTiles(projection).filter(function (t) {
        return !nearNullIsland(t.xyz[0], t.xyz[1], t.xyz[2]);
    });
    console.log("var tiles = ", tiles);
    //console.log("     which.inflight ", which.inflight);

    // which.inflight seems to always be undefined
    _filter(which.inflight, function (v, k) {
        var wanted = _find(tiles, function (tile) { return k === (tile.id + ',0'); });
        if (!wanted) delete which.inflight[k];
        return !wanted;
    }).map(abortRequest);

    tiles.forEach(function (tile) {
        ////console.log("     tile to load = ", tile);
        // //console.log("     tile extent to load = ", tile.extent[0][1] + ',' + tile.extent[0][0] + ',' + tile.extent[1][1] + ',' + tile.extent[1][0]);
        // //console.log("     tile extent to load (MS):   n=", tile.extent[1][1] + '&s=' + tile.extent[0][1] + '&e=' + tile.extent[1][0] + '&w=' + tile.extent[0][0]);
        loadNextTilePage(which, currZoom, url, tile);
    });
}

// load data for the next tile page in line
function loadNextTilePage(which, currZoom, url, tile) {
    console.log('services - streetside - loadNextTilePage() which: ', which);
    //console.log('services - streetside - loadNextTilePage() currZoom: ', currZoom);
    //console.log('services - streetside - loadNextTilePage() url: ', url);
    console.log('services - streetside - loadNextTilePage() tile: ', tile);
    var cache = _mlyCache[which],
        rect = tile.extent.rectangle(),
        maxPages = maxPageAtZoom(currZoom),
        nextPage = cache.nextPage[tile.id] || 0;
        console.log('maxPages = ', maxPages);
        console.log('cache.nextPage[tile.id] - ', cache.nextPage[tile.id]);
        console.log('nextPage = ', nextPage);
        switch (which) {
        case 'bubbles':
            //console.log('services - streetside - loadNextTilePage() nextPage > maxPages?: ', nextPage > maxPages);
            
            if (nextPage > maxPages) return;

            
            var id = tile.id + ',' + String(nextPage);
            //console.log('services - streetside - loadNextTilePage() cache.loaded[id]: ', cache.loaded[id]);
            //console.log('services - streetside - loadNextTilePage() cache.inflight[id]: ', cache.inflight[id]);
            if (cache.loaded[id] || cache.inflight[id]) return;

            cache.inflight[id] = true;
            getBubbles(url, tile, function (bubbles) {
                cache.loaded[id] = true;
                delete cache.inflight[id];
                //console.log("bubbles: ", bubbles);
                if (!bubbles) return;
                // remove first element, statistic info on request, not a bubble
                bubbles.shift();
                var features = bubbles.map(function (bubble) {
                    //console.log("bubble: ", bubble);
                    var loc = [bubble.lo, bubble.la];
                    var d = {
                        loc: loc,
                        key: bubble.id,
                        ca: bubble.he,
                        captured_at: bubble.cd,
                        captured_by: "microsoft",
                        nbn: bubble.nbn,
                        pbn: bubble.pbn,
                        rn: bubble.rn,
                        pano: true
                    };
                    var feature = {
                        geometry: {
                            coordinates: [bubble.lo, bubble.la],
                            type: "Point"
                        },
                        properties: d,
                        type: "Feature"
                    };
                    var bubbleId = bubble.id;
                    cache.points[bubbleId] = feature;
                    cache.forImageKey[bubbleId] = bubbleId;
                    // return false;  // because no `d` data worth loading into an rbush
                    //console.log('End of GetBubbles success handling: cache = ', cache);
                    return {
                        minX: loc[0], minY: loc[1], maxX: loc[0], maxY: loc[1], data: d
                    };

                }).filter(Boolean);
                // //console.log("bubble features: ", features);
                cache.rtree.load(features);
                
            });
            break;
        default:
            var nextURL = cache.nextURL[tile.id] || url +
                utilQsString({
                    per_page: maxResults,
                    page: nextPage,
                    client_id: clientId,
                    bbox: [rect[0], rect[1], rect[2], rect[3]].join(','),
                });
            ////console.log("cache for loadNextTilePage: ", cache);
            if (nextPage > maxPages) return;

            var id = tile.id + ',' + String(nextPage);
            if (cache.loaded[id] || cache.inflight[id]) return;
            ////console.log("get nextURL: ", nextURL);
            cache.inflight[id] = d3_request(nextURL)
                .mimeType('application/json')
                .response(function (xhr) {
                    var linkHeader = xhr.getResponseHeader('Link');
                    if (linkHeader) {
                        var pagination = parsePagination(xhr.getResponseHeader('Link'));
                        if (pagination.next) {
                            cache.nextURL[tile.id] = pagination.next;
                        }
                    }
                    ////console.log("     reponse from nextURL:",xhr.responseText);
                    return JSON.parse(xhr.responseText);
                })
                .get(function (err, data) {
                    cache.loaded[id] = true;
                    delete cache.inflight[id];
                    if (err || !data.features || !data.features.length) return;
                    // //console.log("features returned by mapillary: ", data.features);
                    var features = data.features.map(function (feature) {
                        var loc = feature.geometry.coordinates,
                            d;

                        if (which === 'images') {
                            d = {
                                loc: loc,
                                key: feature.properties.key,
                                ca: feature.properties.ca,
                                captured_at: feature.properties.captured_at,
                                captured_by: feature.properties.username,
                                pano: feature.properties.pano
                            };
                            cache.forImageKey[d.key] = d;     // cache imageKey -> image

                        } else if (which === 'sequences') {
                            // //console.log("sequence", feature);
                            var sequenceKey = feature.properties.key;
                            cache.lineString[sequenceKey] = feature;           // cache sequenceKey -> lineString
                            feature.properties.coordinateProperties.image_keys.forEach(function (imageKey) {
                                cache.forImageKey[imageKey] = sequenceKey;     // cache imageKey -> sequenceKey
                            });
                            return false;  // because no `d` data worth loading into an rbush

                        } else if (which === 'objects') {
                            d = {
                                loc: loc,
                                key: feature.properties.key,
                                value: feature.properties.value,
                                package: feature.properties.package,
                                detections: feature.properties.detections
                            };

                            // cache imageKey -> detectionKey
                            feature.properties.detections.forEach(function (detection) {
                                var imageKey = detection.image_key;
                                var detectionKey = detection.detection_key;
                                if (!_mlyCache.detections[imageKey]) {
                                    _mlyCache.detections[imageKey] = {};
                                }
                                if (!_mlyCache.detections[imageKey][detectionKey]) {
                                    _mlyCache.detections[imageKey][detectionKey] = {};
                                }
                            });
                        }

                        return {
                            minX: loc[0], minY: loc[1], maxX: loc[0], maxY: loc[1], data: d
                        };

                    }).filter(Boolean);
                    ////console.log("mapillary features: ", features);
                    cache.rtree.load(features);

                    if (which === 'images' || which === 'sequences') {
                        dispatch.call('loadedImages');
                    } else if (which === 'objects') {
                        dispatch.call('loadedSigns');
                    }

                    if (data.features.length === maxResults) {  // more pages to load
                        cache.nextPage[tile.id] = nextPage + 1;
                        loadNextTilePage(which, currZoom, url, tile);
                    } else {
                        cache.nextPage[tile.id] = Infinity;     // no more pages to load
                    }
                    // //console.log("_mlyCache: ", _mlyCache);
                });
            break;
    }
}

// call the bubble api and get the json data
// for the tile extent
function getBubbles(url, tile, callback) {
    //console.log('services - streetside - getBubbles()');
    var rect = tile.extent.rectangle()
    jsonpRequest(url + utilQsString({
        n: rect[3],
        s: rect[1],
        e: rect[2],
        w: rect[0],
        appkey: appkey,
        jsCallback: '{callback}'
    }), function (data) {
        if (!data || data.error) {
            callback(null);
        } else {
            callback(data);
        }
    });
}

// extract links to pages of API results
function parsePagination(links) {
    return links.split(',').map(function (rel) {
        var elements = rel.split(';');
        if (elements.length === 2) {
            return [
                /<(.+)>/.exec(elements[0])[1],
                /rel="(.+)"/.exec(elements[1])[1]
            ];
        } else {
            return ['', ''];
        }
    }).reduce(function (pagination, val) {
        pagination[val[1]] = val[0];
        return pagination;
    }, {});
}


// partition viewport into `psize` x `psize` regions
function partitionViewport(psize, projection) {
    var dimensions = projection.clipExtent()[1];
    psize = psize || 16;
    var cols = d3_range(0, dimensions[0], psize),
        rows = d3_range(0, dimensions[1], psize),
        partitions = [];

    rows.forEach(function (y) {
        cols.forEach(function (x) {
            var min = [x, y + psize],
                max = [x + psize, y];
            partitions.push(
                geoExtent(projection.invert(min), projection.invert(max)));
        });
    });

    return partitions;
}


// no more than `limit` results per partition.
function searchLimited(psize, limit, projection, rtree) {
    //console.log('services - streetside - searchLimited()');
    limit = limit || 3;

    var partitions = partitionViewport(psize, projection);
    var results;

    // console.time('previous');
    results = _flatten(_map(partitions, function (extent) {
        return rtree.search(extent.bbox())
            .slice(0, limit)
            .map(function (d) { return d.data; });
    }));
    // console.timeEnd('previous');

    // console.time('new');
    // results = partitions.reduce(function(result, extent) {
    //     var found = rtree.search(extent.bbox())
    //         .map(function(d) { return d.data; })
    //         .sort(function(a, b) {
    //             return a.loc[1] - b.loc[1];
    //             // return a.key.localeCompare(b.key);
    //         })
    //         .slice(0, limit);

    //     return (found.length ? result.concat(found) : result);
    // }, []);
    // console.timeEnd('new');

    return results;
}



export default {
    // initialize streetside
    init: function () {
        if (!_mlyCache) {
            this.reset();
        }

        this.event = utilRebind(this, dispatch, 'on');
    },
    // reset the cache
    reset: function () {
        var cache = _mlyCache;

        if (cache) {
            if (cache.bubbles && cache.bubbles.inflight) {
                _forEach(cache.bubbles.inflight, abortRequest);
            }
            if (cache.images && cache.images.inflight) {
                _forEach(cache.images.inflight, abortRequest);
            }
            if (cache.objects && cache.objects.inflight) {
                _forEach(cache.objects.inflight, abortRequest);
            }
            if (cache.sequences && cache.sequences.inflight) {
                _forEach(cache.sequences.inflight, abortRequest);
            }
        }

        _mlyCache = {
            bubbles: { inflight: {}, loaded: {}, nextPage: {}, nextURL: {}, rtree: rbush(), forImageKey: {}, points: {} },
            images: { inflight: {}, loaded: {}, nextPage: {}, nextURL: {}, rtree: rbush(), forImageKey: {} },
            objects: { inflight: {}, loaded: {}, nextPage: {}, nextURL: {}, rtree: rbush() },
            sequences: { inflight: {}, loaded: {}, nextPage: {}, nextURL: {}, rtree: rbush(), forImageKey: {}, lineString: {} },
            detections: {}
        };

        _mlySelectedImage = null;
        _mlyClicks = [];
    },

    //called by update() in svg - services.js
    bubbles: function (projection) {
        //console.log('services - streetside - bubbles()');
        var psize = 32, limit = 3;
        return searchLimited(psize, limit, projection, _mlyCache.bubbles.rtree);
    },

    images: function (projection) {
        var psize = 16, limit = 3;
        return searchLimited(psize, limit, projection, _mlyCache.images.rtree);
    },


    signs: function (projection) {
        var psize = 32, limit = 3;
        return searchLimited(psize, limit, projection, _mlyCache.objects.rtree);
    },


    sequences: function (projection) {
        var viewport = projection.clipExtent();
        var min = [viewport[0][0], viewport[1][1]];
        var max = [viewport[1][0], viewport[0][1]];
        var bbox = geoExtent(projection.invert(min), projection.invert(max)).bbox();
        var sequenceKeys = {};

        // all sequences for images in viewport
        _mlyCache.images.rtree.search(bbox)
            .forEach(function (d) {
                var sequenceKey = _mlyCache.sequences.forImageKey[d.data.key];
                if (sequenceKey) {
                    sequenceKeys[sequenceKey] = true;
                }
            });

        // Return lineStrings for the sequences
        return Object.keys(sequenceKeys).map(function (sequenceKey) {
            return _mlyCache.sequences.lineString[sequenceKey];
        });
    },

    signsSupported: function () {
        var detected = utilDetect();
        if (detected.ie) return false;
        if ((detected.browser.toLowerCase() === 'safari') && (parseFloat(detected.version) < 10)) return false;
        return true;
    },


    signHTML: function (d) {
        if (!_mlySignDefs || !_mlySignSprite) return;
        var position = _mlySignDefs[d.value];
        if (!position) return '<div></div>';
        var iconStyle = [
            'background-image:url(' + _mlySignSprite + ')',
            'background-repeat:no-repeat',
            'height:' + position.height + 'px',
            'width:' + position.width + 'px',
            'background-position-x:-' + position.x + 'px',
            'background-position-y:-' + position.y + 'px',
        ];

        return '<div style="' + iconStyle.join(';') + '"></div>';
    },

    // this is called a bunch of times repeatedly 
    loadImages: function (projection) {
        //console.log('services - streetside - loadImages()');
        loadTiles('bubbles', msapi + 'GetBubbles.ashx?', projection);
        //loadTiles('images', apibase + 'images?', projection);
        //loadTiles('sequences', apibase + 'sequences?', projection);
    },


    // loadSigns: function (context, projection) {
    //     // if we are looking at signs, we'll actually need to fetch images too
    //     loadTiles('images', apibase + 'images?', projection);
    //     loadTiles('objects', apibase + 'objects?', projection);

    //     // load traffic sign defs
    //     if (!_mlySignDefs) {
    //         _mlySignSprite = context.asset('img/traffic-signs/traffic-signs.png');
    //         _mlySignDefs = {};
    //         d3_json(context.asset('img/traffic-signs/traffic-signs.json'), function (err, data) {
    //             if (err) return;
    //             _mlySignDefs = data;
    //         });
    //     }
    // },

    // create the streeside viewer
    loadViewer: function (context) {
        //console.log('services - streetside - loadViewer()');
        // create ms-wrapper a photo wrapper class
        var wrap = d3_select('#photoviewer').selectAll('.ms-wrapper')
            .data([0]);

        // inject ms-wrapper into the photoviewer div (used by all
        // to house each custom photo viewer)
        var wrapEnter = wrap.enter()
            .append('div')
            .attr('id', 'ms')
            .attr('class', 'photo-wrapper ms-wrapper')
            .classed('hide', true);

        // inject div to support streetside viewer (pannellum)
        wrapEnter
            .append('div')
            .attr('id','viewer-streetside');
            //.attr('class','photo-viewer-streetside');

        // inject div to support photo attribution into ms-wrapper
        wrapEnter
            .append('div')
            .attr('class', 'photo-attribution-streetside fillD');

        // // inject child div for the pannellum viewer
        // var wrap2 = d3_select('#viewer-streetside-wrapper').selectAll('#streetside-viewer').data([0]);
        // wrap2.enter()
        //     .append('div')
        //     .attr('id','viewer-streetside');

        // load streetside pannellum viewer css
        d3_select('head').selectAll('#streetside-viewercss')
        .data([0])
        .enter()
        .append('link')
        .attr('id', 'streetside-viewercss')
        .attr('rel', 'stylesheet')
        .attr('href', context.asset(streetsideViewerCss));

        // load streetside pannellum viewer js
        d3_select('head').selectAll('#streetside-viewerjs')
            .data([0])
            .enter()
            .append('script')
            .attr('id', 'streetside-viewerjs')
            .attr('src', context.asset(streetsideViewer));
    },


    showViewer: function () {
        //console.log('services - streetside - showViewer()');
        var wrap = d3_select('#photoviewer')
            .classed('hide', false);

        var isHidden = wrap.selectAll('.photo-wrapper.ms-wrapper.hide').size();

        if (isHidden) {
            wrap
                .selectAll('.photo-wrapper:not(.ms-wrapper)')
                .classed('hide', true);

            wrap
                .selectAll('.photo-wrapper.ms-wrapper')
                .classed('hide', false);

            //_mlyViewer.resize();
        }

        return this;
    },


    hideViewer: function () {
        _mlySelectedImage = null;

        if (!_mlyFallback && _mlyViewer) {
            _mlyViewer.getComponent('sequence').stop();
        }

        var viewer = d3_select('#photoviewer');
        if (!viewer.empty()) viewer.datum(null);

        viewer
            .classed('hide', true)
            .selectAll('.photo-wrapper')
            .classed('hide', true);

        d3_selectAll('.viewfield-group, .sequence, .icon-sign')
            .classed('selected', false);

        return this.setStyles(null, true);
    },


    parsePagination: parsePagination,


    updateViewer: function (imageKey, context) {
        if (!imageKey) return this;

        if (!_mlyViewer) {
            this.initViewer(imageKey, context);
        } else {
            _mlyViewer.moveToKey(imageKey)
                .catch(function (e) { console.error('mly3', e); });  // eslint-disabe-line no-console
        }

        return this;
    },


    initViewer: function (imageKey, context) {
        var that = this;
        if (Mapillary && imageKey) {
            var opts = {
                baseImageSize: 320,
                component: {
                    cover: false,
                    keyboard: false,
                    tag: true
                }
            };

            // Disable components requiring WebGL support
            if (!Mapillary.isSupported() && Mapillary.isFallbackSupported()) {
                _mlyFallback = true;
                opts.component = {
                    cover: false,
                    direction: false,
                    imagePlane: false,
                    keyboard: false,
                    mouse: false,
                    sequence: false,
                    tag: false,
                    image: true,        // fallback
                    navigation: true    // fallback
                };
            }

            _mlyViewer = new Mapillary.Viewer('ms', clientId, null, opts);
            _mlyViewer.on('nodechanged', nodeChanged);
            _mlyViewer.moveToKey(imageKey)
                .catch(function (e) { console.error('mly3', e); });  // eslint-disable-line no-console
        }

        // nodeChanged: called after the viewer has changed images and is ready.
        //
        // There is some logic here to batch up clicks into a _mlyClicks array
        // because the user might click on a lot of markers quickly and nodechanged
        // may be called out of order asychronously.
        //
        // Clicks are added to the array in `selectedImage` and removed here.
        //
        function nodeChanged(node) {
            if (!_mlyFallback) {
                _mlyViewer.getComponent('tag').removeAll();  // remove previous detections
            }

            var clicks = _mlyClicks;
            var index = clicks.indexOf(node.key);
            var selectedKey = _mlySelectedImage && _mlySelectedImage.key;

            if (index > -1) {              // `nodechanged` initiated from clicking on a marker..
                clicks.splice(index, 1);   // remove the click
                // If `node.key` matches the current _mlySelectedImage, call `selectImage()`
                // one more time to update the detections and attribution..
                if (node.key === selectedKey) {
                    that.selectImage(_mlySelectedImage, node.key, true);
                }
            } else {             // `nodechanged` initiated from the Mapillary viewer controls..
                var loc = node.computedLatLon ? [node.computedLatLon.lon, node.computedLatLon.lat] : [node.latLon.lon, node.latLon.lat];
                context.map().centerEase(loc);
                that.selectImage(undefined, node.key, true);
            }
        }
    },


    // Pass the image datum itself in `d` or the `imageKey` string.
    // This allows images to be selected from places that dont have access
    // to the full image datum (like the street signs layer or the js viewer)
    selectImage: function (d, imageKey, fromViewer) {
        //console.log('services - streetside - selectIamge(); d = ',d);
        //console.log('services - streetside - selectIamge(); imageKey = ',imageKey);
        //console.log('services - streetside - selectIamge(); fromViewer = ',fromViewer);
        if (!d && imageKey) {
            // If the user clicked on something that's not an image marker, we
            // might get in here.. Cache lookup can fail, e.g. if the user
            // clicked a streetsign, but images are loading slowly asynchronously.
            // We'll try to carry on anyway if there is no datum.  There just
            // might be a delay before user sees detections, captured_at, etc.
            d = _mlyCache.bubbles.forImageKey[imageKey];
        }

        _mlySelectedImage = d;
        var viewer = d3_select('#photoviewer');
        if (!viewer.empty()) viewer.datum(d);

        imageKey = (d && d.key) || imageKey;
        if (!fromViewer && imageKey) {
            _mlyClicks.push(imageKey);
        }

        this.setStyles(null, true);

        var wrap = d3_select('#photoviewer .ms-wrapper');
        var attribution = wrap.selectAll('.photo-attribution-streetside').html('');
        var year = (new Date()).getFullYear();

        if (d) {
            if (d.captured_by) {
                attribution
                    .append('a')
                    .attr('class', 'captured_by')
                    .attr('target', '_blank')
                    .attr('href', 'https://www.microsoft.com/en-us/maps/streetside')
                    .text('©' + year +' Microsoft');

                attribution
                    .append('span')
                    .text('|');
            }

            if (d.captured_at) {
                attribution
                    .append('span')
                    .attr('class', 'captured_at')
                    .text(localeTimestamp(d.captured_at));
            }

            attribution
                .append('a')
                .attr('class', 'image_link')
                .attr('target', '_blank')
                .attr('href', 'https://www.bing.com/maps/privacyreport/streetsideprivacyreport?bubbleid=' + encodeURIComponent(d.key) +
                    '&focus=photo&lat=' + d.loc[1] + '&lng=' + d.loc[0] + '&z=17')
                .text('Report a privacy concern with this image');

            //this.updateDetections(d);

            var bubbleIdQuadKey = d.key.toString(4);
            var paddingNeeded = 16 - bubbleIdQuadKey.length;
            for (var i = 0; i < paddingNeeded ;i++)
            {
                bubbleIdQuadKey = "0" + bubbleIdQuadKey;
            }
            var imgLocIdxArr = ['01','02','03','10','11','12']; //Order matters here: front=01, right=02, back=03, left=10 up=11,= down=12
            var imgUrlPrefix = bubbleapi + 'hs' + bubbleIdQuadKey;
            var imgUrlSuffix = '.jpg?g=6338&n=z';
            pannellum.viewer('viewer-streetside', {
                "type": "cubemap",
                "cubeMap": [
                    imgUrlPrefix + imgLocIdxArr[0] +  imgUrlSuffix,
                    imgUrlPrefix + imgLocIdxArr[1] +  imgUrlSuffix,
                    imgUrlPrefix + imgLocIdxArr[2] +  imgUrlSuffix,
                    imgUrlPrefix + imgLocIdxArr[3] +  imgUrlSuffix,
                    imgUrlPrefix + imgLocIdxArr[4] +  imgUrlSuffix,
                    imgUrlPrefix + imgLocIdxArr[5] +  imgUrlSuffix
                ],
                "showFullscreenCtrl": false,
                "autoLoad": true
            }); 
        }
        ////console.log("clicked a streetside image: ", d);
        return this;
    },


    getSelectedImage: function () {
        return _mlySelectedImage;
    },


    getSequenceKeyForImage: function (d) {
        var imageKey = d && d.key;
        return imageKey && _mlyCache.sequences.forImageKey[imageKey];
    },


    setStyles: function (hovered, reset) {
        if (reset) {  // reset all layers
            d3_selectAll('.viewfield-group')
                .classed('highlighted', false)
                .classed('hovered', false)
                .classed('selected', false);

            d3_selectAll('.sequence')
                .classed('highlighted', false)
                .classed('selected', false);
        }

        var hoveredImageKey = hovered && hovered.key;
        var hoveredBubbleKey = hovered && hovered.key;
        var hoveredSequenceKey = this.getSequenceKeyForImage(hovered);
        var hoveredLineString = hoveredSequenceKey && _mlyCache.sequences.lineString[hoveredSequenceKey];
        var hoveredImageKeys = (hoveredLineString && hoveredLineString.properties.coordinateProperties.image_keys) || [];

        var viewer = d3_select('#photoviewer');
        var selected = viewer.empty() ? undefined : viewer.datum();
        var selectedBubbleKey = selected && selected.key;
        var selectedImageKey = selected && selected.key;
        var selectedSequenceKey = this.getSequenceKeyForImage(selected);
        var selectedLineString = selectedSequenceKey && _mlyCache.sequences.lineString[selectedSequenceKey];
        var selectedImageKeys = (selectedLineString && selectedLineString.properties.coordinateProperties.image_keys) || [];

        // highlight sibling viewfields on either the selected or the hovered sequences
        var highlightedBubbleKeys = _union(hoveredBubbleKey, selectedBubbleKey);

        d3_selectAll('.layer-streetside-images .viewfield-group')
            .classed('highlighted', function (d) { return highlightedBubbleKeys.indexOf(d.key) !== -1; })
            .classed('hovered', function (d) { return d.key === hoveredBubbleKey; })
            .classed('selected', function (d) { return d.key === selectedBubbleKey; });

        d3_selectAll('.layer-streetside-images .sequence')
            .classed('highlighted', function (d) { return d.properties.key === hoveredSequenceKey; })
            .classed('selected', function (d) { return d.properties.key === selectedSequenceKey; });

        return this;
    },


    updateDetections: function (d) {
        if (!_mlyViewer || _mlyFallback) return;

        var imageKey = d && d.key;
        var detections = (imageKey && _mlyCache.detections[imageKey]) || [];

        _forEach(detections, function (data, k) {
            if (_isEmpty(data)) {
                loadDetection(k);
            } else {
                var tag = makeTag(data);
                if (tag) {
                    var tagComponent = _mlyViewer.getComponent('tag');
                    tagComponent.add([tag]);
                }
            }
        });


        function loadDetection(detectionKey) {
            var url = apibase + 'detections/' +
                detectionKey + '?' + utilQsString({
                    client_id: clientId,
                });

            d3_request(url)
                .mimeType('application/json')
                .response(function (xhr) {
                    return JSON.parse(xhr.responseText);
                })
                .get(function (err, data) {
                    if (!data || !data.properties) return;

                    var imageKey = data.properties.image_key;
                    _mlyCache.detections[imageKey][detectionKey] = data;

                    var selectedKey = _mlySelectedImage && _mlySelectedImage.key;
                    if (imageKey === selectedKey) {
                        var tag = makeTag(data);
                        if (tag) {
                            var tagComponent = _mlyViewer.getComponent('tag');
                            tagComponent.add([tag]);
                        }
                    }
                });
        }


        function makeTag(data) {
            var valueParts = data.properties.value.split('--');
            if (valueParts.length !== 3) return;

            var text = valueParts[1].replace(/-/g, ' ');
            var tag;

            // Currently only two shapes <Polygon|Point>
            if (data.properties.shape.type === 'Polygon') {
                var polygonGeometry = new Mapillary
                    .TagComponent
                    .PolygonGeometry(data.properties.shape.coordinates[0]);

                tag = new Mapillary.TagComponent.OutlineTag(
                    data.properties.key,
                    polygonGeometry,
                    {
                        text: text,
                        textColor: 0xffff00,
                        lineColor: 0xffff00,
                        lineWidth: 2,
                        fillColor: 0xffff00,
                        fillOpacity: 0.3,
                    }
                );

            } else if (data.properties.shape.type === 'Point') {
                var pointGeometry = new Mapillary
                    .TagComponent
                    .PointGeometry(data.properties.shape.coordinates[0]);

                tag = new Mapillary.TagComponent.SpotTag(
                    data.properties.key,
                    pointGeometry,
                    {
                        text: text,
                        color: 0xffff00,
                        textColor: 0xffff00
                    }
                );
            }

            return tag;
        }
    },


    cache: function () {
        return _mlyCache;
    },


    signDefs: function (_) {
        if (!arguments.length) return _mlySignDefs;
        _mlySignDefs = _;
        return this;
    }

};
