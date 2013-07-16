/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */



/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, forin: true, maxerr: 50, regexp: true */
/*global define, $, FileError, window, chrome */

 /**
 * Inspector manages the connection to Chrome/Chromium's remote debugger.
 * See inspector.html for the documentation of the remote debugger.
 *
 * The remote debugger is enabled through a Chrome extension and communication
 * is done through Chrome extension message passing.
 *
 * # EVENTS
 *
 * Inspector dispatches several connectivity-related events + all remote debugger
 * events (see below). Event handlers are attached via `on(event, function)` and
 * detached via `off(event, function)`.
 *
 *   `connect`    Inspector did successfully connect to the remote debugger
 *   `disconnect` Inspector did disconnect from the remote debugger
 *   `error`      Inspector encountered an error
 *   `message`    Inspector received a message from the remote debugger - this
 *                  provides a low-level entry point to remote debugger events
 *
 * # REMOTE DEBUGGER COMMANDS
 *
 * Commands are executed by calling `{Domain}.{Command}()` with the parameters
 * specified in the order of the remote debugger documentation. These command
 * functions are generated automatically at runtime from Inspector.json. The
 * actual implementation of these functions is found in
 * `_send(method, signature, varargs)`, which verifies, serializes, and
 * transmits the command to the remote debugger. If the last parameter of any
 * command function call is a function, it will be used as the callback.
 *
 * # REMOTE DEBUGGER EVENTS
 *
 * Debugger events are dispatched as regular events using {Domain}.{Event} as
 * the event name. The handler function will be called with a single parameter
 * that stores all returned values as an object.
 */
define(function Inspector(require, exports, module) {
    "use strict";
    
    // jQuery exports object for events
    var $exports = $(exports);

    var _messageId = 1; // id used for remote method calls, auto-incrementing
    var _messageCallbacks = {}; // {id -> function} for remote method calls
    var _connectDeferred; // The deferred connect
    var _extensionID = "hfhmgjnmhoohakhkieckckiheidgmkfd";
    var _port;
    var _portId = 0;
    
    function _trace(msg) {
        console.log(msg);
    }

    /** Check a parameter value against the given signature
     * This only checks for optional parameters, not types
     * Type checking is complex because of $ref and done on the remote end anyways
     * @param {signature}
     * @param {value}
     */
    function _verifySignature(signature, value) {
        if (value === undefined) {
            console.assert(signature.optional === true, "Missing argument: " + signature.name);
        }
        return true;
    }

    /** Send a message to the remote debugger
     * All passed arguments after the signature are passed on as parameters.
     * If the last argument is a function, it is used as the callback function.
     * @param {string} remote method
     * @param {object} the method signature
     */
    function _send(method, signature, varargs) {
        if (!_port) {
            // FUTURE: Our current implementation closes and re-opens an inspector connection whenever
            // a new HTML file is selected. If done quickly enough, pending requests from the previous
            // connection could come in before the new socket connection is established. For now we 
            // simply ignore this condition. 
            // This race condition will go away once we support multiple inspector connections and turn
            // off auto re-opening when a new HTML file is selected.
            return;
        }

        console.assert(_port, "You must connect to the WebSocket before sending messages.");
        var id, callback, args, i, params = {}, promise;

        // extract the parameters, the callback function, and the message id
        args = Array.prototype.slice.call(arguments, 2);
        if (typeof args[args.length - 1] === "function") {
            callback = args.pop();
        } else {
            var deferred = new $.Deferred();
            promise = deferred.promise();
            callback = function (result) {
                deferred.resolve(result);
            };
        }

        id = _messageId++;
        _messageCallbacks[id] = callback;

        // verify the parameters against the method signature
        // this also constructs the params object of type {name -> value}
        for (i in signature) {
            if (_verifySignature(args[i], signature[i])) {
                params[signature[i].name] = args[i];
            }
        }
        
        
        var message = {
            cmd: "sendCommand",
            method: method,
            params: params,
            id: id
        };
        
        _trace("Executing command " + id + ": " + method + " " + JSON.stringify(params));
        
        _port.postMessage(message, callback);

        return promise;
    }

    /** Port closed */
    function _onDisconnect() {
        _trace("** Port disconnected **");
        $exports.triggerHandler("disconnect");
        _port = null;
    }

    /** Port reported an error */
    function _onError(error) {
        if (_connectDeferred) {
            _trace("** !!! Port error: " + JSON.stringify(error) + " **");
            _connectDeferred.reject();
            _connectDeferred = null;
        }
        $exports.triggerHandler("error", [error]);
    }

    /** Port connected */
    function _onConnect() {
        _trace("** Port connected **");
        if (_connectDeferred) {
            _connectDeferred.resolve();
            _connectDeferred = null;
        }
        $exports.triggerHandler("connect");
    }

    /** Received message from the Port
     * A message can be one of three things:
     *   1. an error -> report it
     *   2. the response to a previous command -> run the stored callback
     *   3. an event -> trigger an event handler method
     * @param {object} message
     */
    function _onMessage(response) {
        $exports.triggerHandler("message", [response]);
        if (response.error) {
            _trace("  !!! Error: " + JSON.stringify(response.error));
            $exports.triggerHandler("error", [response.error]);
        } else if (response.result) {
            if (!response.result.result) {
                // normalize result (sometimes is undefined)
                response.result.result = {
                    type: "undefined"
                };
            }
            _trace("  Result (" + response.id + "): " + JSON.stringify(response.result.result));
            if (_messageCallbacks[response.id]) {
                _messageCallbacks[response.id](response.result);
                delete _messageCallbacks[response.id];
            }
        } else {
            _trace("  Event: " + response.method);
            var domainAndMethod = response.method.split(".");
            var domain = domainAndMethod[0];
            var method = domainAndMethod[1];
            $(exports[domain]).triggerHandler(method, response.params);
        }
    }


    /** Public Functions *****************************************************/

    /** Get a list of the available windows/tabs/extensions that are remote-debuggable
     * @param {string} host IP or name
     * @param {integer} debugger port
     */
    function getDebuggableWindows() {
        var deferred = new $.Deferred();
        chrome.runtime.sendMessage(_extensionID, {
            cmd: "getTargets"
        }, function (targets) {
            if (chrome.runtime.lastError) {
                deferred.reject(chrome.runtime.lastError);
            } else {
                deferred.resolve(targets);
            }
        });
        return deferred.promise();
    }

    /** Register a handler to be called when the given event is triggered
     * @param {string} event name
     * @param {function} handler function
     */
    function on(name, handler) {
        $exports.on(name, handler);
    }

    /** Remove the given or all event handler(s) for the given event or remove all event handlers
     * @param {string} optional event name
     * @param {function} optional handler function
     */
    function off(name, handler) {
        $exports.off(name, handler);
    }

    /**
     * Disconnect from the remote debugger
     * @return {jQuery.Promise} Promise that is resolved immediately if not
     *     currently connected or asynchronously when the port is closed.
     */
    function disconnect() {
        if (_port) {
            _port.disconnect();
            _port.onDisconnect.removeListener(_onDisconnect);
            _port.onMessage.removeListener(_onMessage);
            _port = null;
        }
        return $.when().promise();
    }
    
    /**
     * Connect to the remote debugger
     * Clients must listen for the `connect` event.
     */
    function connect() {
        disconnect().done(function () {
            chrome.runtime.sendMessage(_extensionID, {
                cmd: "attachDebugger"
            }, function (result) {
                if (result.error) {
                    _onError(result.error);
                } else {
                    _port = chrome.runtime.connect(_extensionID, {
                        name: "port-" + _portId++
                    });
                    _port.onDisconnect.addListener(_onDisconnect);
                    _port.onMessage.addListener(_onMessage);
                    _onConnect();
                }
            });
        });
    }
    
    /** Connect to the remote debugger
     */
    function connectToURL() {
        if (_connectDeferred) {
            // reject an existing connection attempt
            _connectDeferred.reject("CANCEL");
        }
        
        _connectDeferred = new $.Deferred();
        
        connect();
        
        return _connectDeferred.promise();
    }

    /** Initialize the Inspector
     * Read the Inspector.json configuration and define the command objects
     * -> Inspector.domain.command()
     */
    function init(theConfig) {
        exports.config = theConfig;

        var InspectorText = require("text!LiveDevelopment/Inspector/Inspector.json"),
            InspectorJSON = JSON.parse(InspectorText);
        
        var i, j, domain, domainDef, command;
        for (i in InspectorJSON.domains) {
            domain = InspectorJSON.domains[i];
            exports[domain.domain] = {};
            for (j in domain.commands) {
                command = domain.commands[j];
                exports[domain.domain][command.name] = _send.bind(undefined, domain.domain + "." + command.name, command.parameters);
            }
        }
    }
    
    /** Check if the inspector is connected */
    function connected() {
        return (_port);
    }

    // Export public functions
    exports.getDebuggableWindows = getDebuggableWindows;
    exports.on = on;
    exports.off = off;
    exports.disconnect = disconnect;
    exports.connect = connect;
    exports.connectToURL = connectToURL;
    exports.connected = connected;
    exports.init = init;
});