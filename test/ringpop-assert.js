var _ = require('lodash');
var async = require('async');
var glob = require('glob');
var jsonschema = require('jsonschema');
var events = require('./events');
var safeJSONParse = require('./util').safeParse;
var util = require('util');
var makeHostPort = require('./util').makeHostPort;

function errDetails(details) {
    return {error:{details:details}};
}

function wait(millis) {
    var f = _.once(function wait(list, cb) {
            setTimeout(function() { cb(list); }, millis);
    });
    f.callerName = 'wait';
    return f;
}

function waitForJoins(t, tc, n) {
    n = _.min([6, n]);
    return function waitForJoins(list, cb) {
        var joins = _.filter(list, {type: events.Types.Join});
        if (joins.length < n) {
            cb(null);
            return;
        }
        
        t.equals(joins.length, n, 'check number of joins', 
            errDetails({journal: _.pluck(list, 'endpoint')}));

        //XXX: a bit wonky to get sutIncarnationNumber like this
        tc.sutIncarnationNumber = safeJSONParse(list[0].arg3).incarnationNumber;
        cb(_.reject(list, {type: events.Types.Join}));
    };
}

function waitForPingReqs(t, tc, n) {
    return function waitForPingReqs(list, cb) {
        var pingReqs = _.filter(list, {type: events.Types.PingReq});

        if (pingReqs.length < n) {
            cb(null);
            return;
        }

        t.equal(pingReqs.length, n, 'check number of ping-reqs',
            errDetails({pingReqs: pingReqs}));

        cb(_.reject(list, {type: events.Types.PingReq, direction: 'request'}));
    }
}

function waitForPing(t, tc) {
    return function waitForPing(list, cb) {
        var index = _.findIndex(list, {
            type: events.Types.Ping,
            direction: 'request'
        });

        if (index === -1) {
            // there is no ping, continue
            return cb(null);
        }

        list.splice(index, 1); // remove ping from list

        return cb(list);
    };
}

function waitForEmptyPing(t, tc) {
    // Waits for a ping with an empty changes list, and consumes all pings with changes in them
    // usefull to wait for a 'stable' SUT before doing piggyback tests. Given that decay works in the SUT
    return function waitForEmptyPing(list, cb) {
        var pings = _.filter(list, {
            type: events.Types.Ping,
            direction: 'request'
        });

        if (pings.length === 0) {
            // there is no ping, so by definition there will be no empty ping
            return cb(null);
        }

        var nonEmptyPings = pings.filter(function (ping) {
            return ping.body.changes && ping.body.changes.length > 0;
        });

        if (pings.length === nonEmptyPings.length) {
            // all pings are non-empty
            return cb(null);
        }
        
        // remove all pings
        list = _.reject(list, {
            type: events.Types.Ping,
            direction: 'request'
        });

        return cb(list);
    };
}

function validateEventBody(t, tc, selector, msg, testFn) {
    return function validateEventBody(list, cb) {
        var index = _.findIndex(list, selector);
        if (index < 0) return cb(null); // found no event

        t.ok(testFn(list[index]), msg, errDetails({
            body: list[index] && list[index].body
        }));
        list.splice(index, 1); // remove tested item from event list
        return cb(list);
    };
}

// prefered method since it should be faster, but need to send the correct checksum
// this has the benefit of having checksum validation as well.
function drainSUTDissemination(t, tc) {
    return function drainSUTDissemination(list, cb){
        var lastPing = null;
        // use the first fake node to send all the pings needed
        async.doWhilst(function sendPing(callback) {
            tc.fakeNodes[0].requestPing(function (err, res, arg2, arg3) {
                if (err) return callback(err);

                lastPing = safeJSONParse(arg3);
                console.dir(lastPing);
                if (!lastPing) return callback(new Error("No ping body received"));

                return callback();
            });
        }, function testIfPingIsEmpty() {
            return lastPing.changes.length === 0;
        }, function done(err) {
            // throw err for now when present since cb is not the typical err first callback right now
            if (err) throw err;

            console.log(list.length);
        });
    };
}

function joinNewNode(t, tc, nodeIx) {
    return [
        addFakeNode(t, tc),
        sendJoin(t, tc, nodeIx),
    ];
}

function addFakeNode(t, tc) {
    var f = _.once(function addNode(list, cb) {
        var node = tc.createFakeNode();
        node.start(cb.bind(null, list));
    });
    f.callerName = 'addFakeNode';
    return f;
}

function sendJoin(t, tc, nodeIx) {
    var f = _.once(function sendJoin(list, cb) {
        tc.fakeNodes[nodeIx].requestJoin(function() {
            cb(list);
        });
    });
    f.callerName = 'sendJoin';
    return f;
}

function sendPings(t, tc, nodeIxs) {
    return _.map(nodeIxs, function(ix) {
        return sendPing(t, tc, ix);
    });
}

function sendPing(t, tc, nodeIx, piggybackOpts) {
    var f = _.once(function sendPing(list, cb) {
        var piggybackData = piggyback(tc, piggybackOpts);
        
        tc.fakeNodes[nodeIx].requestPing(function() {
            cb(list);
        }, piggybackData);
    });
    f.callerName = 'sendPing';
    return f;
}

function waitForPingResponses(t, tc, nodeIxs) {
    return _.map(nodeIxs, function(ix) {
        return waitForPingResponse(t, tc, ix);
    });
}

function waitForPingResponse(t, tc, nodeIx) {
    return function waitForPingResponse(list, cb) {
        var pings = _.filter(list, {type: events.Types.Ping, direction: 'response'});
        pings = _.filter(pings, function(event) {
            return event.receiver === tc.fakeNodes[nodeIx].getHostPort();
        });
        
        if(pings.length === 0) {
            cb(null);
            return;
        }

        _.pullAt(list, _.indexOf(list, pings[0]));
        cb(list);
    };
}

function waitForJoinResponse(t, tc, nodeIx) {
    return function waitForJoinResponse(list, cb) {
        var joins = _.filter(list, {type: events.Types.Join, direction: 'response'});
        joins = _.filter(joins, function(event) {
            return event.receiver === tc.fakeNodes[nodeIx].getHostPort();
        });
        
        if(joins.length === 0) {
            cb(null);
            return;
        }

        _.pullAt(list, _.indexOf(list, joins[0]));
        cb(list);
    };
}

function sendPingReq(t, tc, nodeIx, targetIx, piggybackOpts) {
    var f = _.once(function sendPing(list, cb) {
        var piggybackData = piggyback(tc, piggybackOpts);
        var target = tc.fakeNodes[targetIx].getHostPort();
        tc.fakeNodes[nodeIx].requestPingReq(target, function() {
            cb(list);
        }, piggybackData);
    });
    f.callerName = 'sendPingReq';
    return f;
}

function waitForPingReqResponse(t, tc, nodeIx, targetIx, status) {
    return function waitForPingReqResponse(list, cb) {
        var pingReqs = _.filter(list, {type: events.Types.PingReq, direction: 'response'});
        pingReqs = _.filter(pingReqs, function(event) {
            return event.receiver === tc.fakeNodes[nodeIx].getHostPort();
        });
        
        if(pingReqs.length === 0) {
            cb(null);
            return;
        }

        // TODO(wieger): validate pingReqs[0]
        var arg3 = safeJSONParse(pingReqs[0].arg3);
        t.equal(arg3.target, tc.fakeNodes[targetIx].getHostPort(),
            'check target of the response',
            errDetails({"ping-req-response": arg3}));
        t.equal(arg3.pingStatus, status, 
            'check target ping status of the response', 
            errDetails({"ping-req-response": arg3}));

        _.pullAt(list, _.indexOf(list, pingReqs[0]));
        cb(list);
    }
}

// TODO(wieger): make general request for ping, pingreqs, join
// with a callback that manipulates the requested object
// function waitForResponse(t, tc, type, nodeIx, validateResponseCB) {}

// count is optional, when a number it will fail if there are pings

function expectOnlyPings(t, tc, count) {
    return function expectOnlyPings(list, cb) {
        var pings = _.filter(list, {type: events.Types.Ping, direction: 'request'});
        t.equal(pings.length, list.length, 
            'check if all remaining events are Pings',
            errDetails({eventTypes: 
                _.zip(_.pluck(list, 'type'), _.pluck(list, 'direction'))
            })
        );

        if (typeof count === 'number') {
            t.equal(pings.length, count, "Checking the number of pings", errDetails({
                pings: _.zip(
                    _.pluck(list, 'type'),
                    _.pluck(list, 'direction')
                )
            }));
        } 

        cb(_.reject(list, {type: events.Types.Ping, direction: 'request'}));
    };
}

function expectOnlyPingsAndPingReqs(t, tc) {
    return function expectOnlyPingsAndPingReqs(list, cb) {
        var pings = _.filter(list, {type: events.Types.Ping, direction: 'request'});
        var pingReqs = _.filter(list, {type: events.Types.PingReq, direction: 'request'});
        t.equal(pings.length + pingReqs.length, list.length, 
            'check if all remaining events are pings or ping-reqs',
            errDetails({eventTypes: 
                _.zip(_.pluck(list, 'type'), _.pluck(list, 'direction'))
            })
        );

        var result = list
        result = _.reject(result, {type: events.Types.Ping, direction: 'request'});
        result = _.reject(result, {type: events.Types.PingReq, direction: 'request'});
        cb(result);
    }
}

function consumePings(t, tc) {
    return function consumePings(list, cb) {
        cb(_.reject(list, {type: events.Types.Ping, direction: 'request'}));
    };
}

function callEndpoint(t, tc, endpoint, body, validateEvent) {
    return function (list, cb) {
        tc.callEndpoint(endpoint, body, function (event) {
            // optional validate the event
            if (validateEvent && typeof validateEvent === 'function') {
                validateEvent(event.body);
            }

            return cb(list);
        });
    };
}


// function assertUpToDateIncarnationNumbers(t, tc) {
//     return [
//         requestAdminStats(tc),
//         waitForStatsCheckIncarnationNumbers(t, tc),
//     ];
// }

// function waitForStatsCheckIncarnationNumber(t, tc) {
//     return function waitForStatsCheckIncarnationNumber(list, cb) {
//         var ix = _.findIndex(list, {type: events.Types.Stats});
//         if (ix === -1) {
//             cb(null);
//             return;
//         }

//         var stats = safeJSONParse(list[ix].arg3);
//         var members = stats.membership.members;

//         members.forEach(function(member) {
//             var found = false;
//             tc.fakeNodes.forEach(function(fakeNode)) {
//                 if (member.address === fakeNode.getHostPort()) {
//                     found = true;

//                 }
//             }
//             if (!found) {
//                 f.fail('member not found in fake nodes', errDetails(members));
//                 return;
//             }
//         });
        
//         _.pullAt(list, ix);
//         cb(list);
//     }
// }

function assertStats(t, tc, a, s, f) {
    return [
        requestAdminStats(tc),
        waitForStatsCheckStatus(t, tc, a, s, f),
    ];
}


function requestAdminStats(tc) {
    var f = _.once(function reuqestAdminStats(list, cb) {
        tc.getAdminStats(function(event) {
            cb(list);
        });
    });
    f.callerName = 'requestAdminStats';
    return f;
}

function waitForStatsCheckStatus(t, tc, alive, suspect, faulty) {
    return function waitForStatsCheckStatus(list, cb) {
        var ix = _.findIndex(list, {type: events.Types.Stats});
        if (ix === -1) {
            cb(null);
            return;
        }

        var stats = safeJSONParse(list[ix].arg3);
        var members = stats.membership.members;
        var a = _.filter(members, {status: 'alive'}).length;
        var s = _.filter(members, {status: 'suspect'}).length;
        var f = _.filter(members, {status: 'faulty'}).length;

        t.equal(a, alive, 'check number of alive nodes');
        t.equal(s, suspect, 'check number of suspect nodes');
        t.equal(f, faulty, 'check number of faulty nodes');
        if(a !== alive || s !== suspect || f !== faulty) {
            t.fail('full stats check', errDetails(members));
        }

        _.pullAt(list, ix);
        cb(list);
    }
}

function assertRoundRobinPings(t, tc, pings, millis) {
    return [
        wait(millis),
        expectRoundRobinPings(t, tc, pings)
    ];
}

// imidiately checks for n-1, n or n+1 pings
function expectRoundRobinPings(t, tc, n) {
    return function expectRoundRobinPings(list, cb) {
        var pings = _.filter(list, {type: events.Types.Ping});
        pings = _.pluck(pings, "req.channel.hostPort");

        // expect ping every 200 ms
        if (pings.length  < n - 1 || pings.length > n + 1) {
            t.fail(util.format('not the right amount of Pings, got %d expected %d +/- 1', pings.length, n),
                errDetails({pings: pings}));
        } else {
            t.pass('check amount of pings received');
        }

        // check if pings are distributed evenly over the membership
        var hostPortFreqs = _.countBy(pings);
        var min = _.min(_.values(hostPortFreqs));
        var max = _.max(_.values(hostPortFreqs));
        t.ok(min == max || min + 1 == max, 
            'pings distributed evenly', 
            errDetails({hostPortFreqs: hostPortFreqs}));
        
        // check if pingrounds are randomized
        var rounds = _.chunk(pings, tc.fakeNodes.length);
        var sliceFreqs = _.countBy(rounds);
        t.ok(_.every(sliceFreqs, function(v, k) { return v === 1; }), 
            'ping rounds should be randomized',
            errDetails({sliceFreqs: sliceFreqs}));

        cb(_.reject(list, {type: events.Types.Ping}));
    }
}

function disableNode(t, tc, ix) {
    var f = _.once(function(list, cb) {
        tc.fakeNodes[ix].shutdown();
        cb(list);
    });
    f.callerName = 'disableNode';
    return f;
}

function enableNode(t, tc, ix, incarnationNumber) {
    var f = _.once(function(list, cb) {
        tc.fakeNodes[ix].start();
        tc.fakeNodes[ix].incarnationNumber = incarnationNumber;
        cb(list);
    });
    f.callerName = 'enableNode';
    return f;
}

function createValidateEvent(t, tc) {
    var Validator = jsonschema.Validator;
    var validator = new Validator();

    // load all json schema files and add them to the valicator
    var schemaFiles = glob.sync("../schema/*.json",{cwd:__dirname});
    schemaFiles.forEach(function (schemaFile) {
        validator.addSchema(require(schemaFile));
    });

    function bodyVerification(name, schema) {
        return function (event, body) {
            var result = validator.validate(body, schema, { propertyName: name.replace(' ','-') });
            t.equals(result.errors.length, 0, "JSON Validation: " + name, errDetails({
                errors: _.pluck(result.errors, "stack"),
                body: body
            }));
        };
    }

    var validators = {
        'request': {},
        'response': {}
    };

    // /protocol/join
    validators.request[events.Types.Join] = bodyVerification("join request", "/JoinRequest");
    validators.response[events.Types.Join] = bodyVerification("join response", "/JoinResponse");

    // /protovol/ping
    validators.request[events.Types.Ping] = bodyVerification("ping request", "/PingRequest");
    validators.response[events.Types.Ping] = bodyVerification("ping response", "/PingResponse");

    // /protovol/ping-req
    validators.request[events.Types.PingReq] = bodyVerification("ping-req request", "/PingReqRequest");
    validators.response[events.Types.PingReq] = bodyVerification("ping-req response", "/PingReqResponse");

    // /admin/stats
    validators.response[events.Types.Stats] = bodyVerification("admin-status response", "/StatsResponse");

    // TODO endpoints to specify and test
    // /admin/debugClear
    // /admin/debugSet
    // /admin/gossip
    // /admin/join
    // /admin/leave
    // /admin/lookup
    // /admin/reload
    // /admin/tick

    return function (event) {
        var type = event.type;
        var direction = event.direction;

        var validator = validators[direction][type];
        if (!validator) return; // nothing to test here

        validator(event, safeJSONParse(event.arg3));
    }; 
}

// validates a scheme on incoming events send by the real-node. A scheme is a collection of
// functions from scheme.js. On every incoming event we try to progress through the scheme. 
// further. When all the functions in the scheme have ran, the test is a success.
function validate(t, tc, scheme, deadline) {
    var fns = scheme;
    var cursor = 0;
    var eventList = [];

    tc.on('event', createValidateEvent(t, tc));

    timer = setTimeout(function() {
        t.fail('timeout');
        tc.removeAllListeners('event');
        tc.shutdown();
        t.end();
    }, deadline);

    // flatten so arrays gets expanded and fns becomes one-dimensional
    fns = _.flatten(fns, true);

    // try to run the fn that the cursor points to. The function indicates that it has
    // succeeded by yielding an updated eventList. If succeeded the cursor progresses 
    // to the next function.
    var inProgress = false;
    var progressFromCursor = function() {
        if (inProgress) return;
        inProgress = true;

        if(cursor >= fns.length) {
            clearTimeout(timer);
            t.ok(true, 'validate done: all functions passed');
            tc.shutdown();
            tc.removeAllListeners('event');
            t.end();

            inProgress = false;
            return;
        }

        if(!fns[cursor].isPrinted) {
            fns[cursor].isPrinted = true;
            var name = fns[cursor].name || fns[cursor].callerName;
            console.log('* starting ' + name);    
        }

        fns[cursor](eventList, function(result) {
            if (result === null) {
                //wait for more events
                inProgress = false;
                return;
            }
            
            eventList = result;
            cursor++;

            inProgress = false;
            progressFromCursor(true);
        });
    }

    tc.on('event', function(event) {
        eventList.push(event);
        progressFromCursor();
    });
}

var uuid = require('node-uuid');

// function piggyback(tc, sourceIx, subjectIx, status, id) {
//     return function() {
//         update = {};
//         update.id = id || uuid.v4();
       
//         if(sourceIx === 'sut') { 
//             update.source = tc.sutHostPort;
//             update.sourceIncarnationNumber = 99999999;
//         } else {
//             update.source = tc.fakeNodes[sourceIx].getHostPort();    
//             update.sourceIncarnationNumber = tc.fakeNodes[sourceIx].incarnationNumber;
//         }

//         if(subjectIx === 'sut') {
//             update.address = tc.sutHostPort;
//             update.sourceIncarnationNumber = 99999999;
//         } else {
//             update.address = tc.fakeNodes[subjectIx].getHostPort();
//             update.incarnationNumber = tc.fakeNodes[subjectIx].incarnationNumber;
//         }
        
//         update.status = status;

//         console.log(update);
//         return update;
//     }
// }

// example opts = {
//    sourceIx: 0,
//    subjectIx: 1,
//    status: 'alive',
//    id: 'abcd-1234',
//    sourceIncNoDelta: 1,
//    subjectIncNoDelta: 1,
// }
function piggyback(tc, opts) { 
    if (opts === undefined) {
        return undefined;
    }
    update = {};
    update.id = opts.id || uuid.v4();
    update.status = opts.status;
    
    if(opts.sourceIx === 'sut') { 
        update.source = tc.sutHostPort;
        update.sourceIncarnationNumber = tc.sutIncarnationNumber;
    } else {
        update.source = tc.fakeNodes[opts.sourceIx].getHostPort();    
        update.sourceIncarnationNumber = tc.fakeNodes[opts.sourceIx].incarnationNumber;
    }

    if (opts.sourceIncNoDetla !== undefined) {
        update.sourceIncarnationNumber += opts.sourceIncNoDelta;
    }

    if(opts.subjectIx === 'sut') {
        update.address = tc.sutHostPort;
        update.sourceIncarnationNumber = tc.sutIncarnationNumber;
    } else {
        update.address = tc.fakeNodes[opts.subjectIx].getHostPort();
        update.incarnationNumber = tc.fakeNodes[opts.subjectIx].incarnationNumber;
    }

    if(opts.subjectIncNoDelta !== undefined) {
        update.incarnationNumber += opts.subjectIncNoDelta;
    }

    return update;
}


module.exports = {
    validate: validate,
    wait: wait,
    
    waitForJoins: waitForJoins,
    waitForPingReqs: waitForPingReqs,
    waitForPing: waitForPing,
    waitForEmptyPing: waitForEmptyPing,
    // drainSUTDissemination: drainSUTDissemination,
    validateEventBody: validateEventBody,

    callEndpoint: callEndpoint,
    consumePings: consumePings,
    
    sendJoin: sendJoin,
    sendPing: sendPing,
    sendPingReq: sendPingReq,
    
    expectOnlyPings: expectOnlyPings,
    expectOnlyPingsAndPingReqs: expectOnlyPingsAndPingReqs,
    
    assertRoundRobinPings: assertRoundRobinPings,
    assertStats: assertStats,
    
    disableNode: disableNode,
    enableNode: enableNode,

    sendPings: sendPings,
    waitForPingResponse: waitForPingResponse,
    waitForPingResponses: waitForPingResponses,

    addFakeNode: addFakeNode,
    joinNewNode: joinNewNode,
    waitForJoinResponse: waitForJoinResponse,

    waitForPingReqResponse: waitForPingReqResponse,

    piggyback: piggyback,
};
