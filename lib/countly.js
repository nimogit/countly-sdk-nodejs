/************
* Countly NodeJS SDK
* https://github.com/Countly/countly-sdk-nodejs
************/

/**
 * Countly object to manage the internal queue and send requests to Countly server
 * @name Countly
 * @global
 * @namespace Countly
 */
 
 var fs = require('fs'),
    os = require('os'),
    path = require('path'),
    http = require('http'),
    https = require('https');

 var Countly = {};
 
(function (Countly) {
	'use strict';

	var inited = false,
		sessionStarted = false,
        platform,
        filePath = "../",
		apiPath = "/i",
		beatInterval = 500,
		requestQueue = [],
		eventQueue = [],
        crashLogs = [],
        timedEvents = {},
        crashSegments = null,
		autoExtend = true,
		lastBeat,
        storedDuration = 0,
        lastView = null,
        lastViewTime = 0,
        lastViewStoredDuration = 0,
        failTimeout = 0,
        failTimeoutAmount = 60,
        readyToProcess = true,
        trackTime = true,
        metrics = {},
        startTime;

/**
* Countly initialization object
* @typedef {Object} Init
* @property {string} app_key - app key for your app created in Countly
* @property {string} device_id - to identify a visitor, will be auto generated if not provided
* @property {string} [url=https://cloud.count.ly] - your Countly server url, you can use your own server URL or IP here
* @property {string} [app_version=0.0] - the version of your app or website
* @property {string=} country_code - country code for your visitor
* @property {string=} city - name of the city of your visitor
* @property {string=} ip_address - ip address of your visitor
* @property {boolean} [debug=false] - output debug info into console
* @property {number} [interval=500] - set an interval how often to check if there is any data to report and report it in miliseconds
* @property {number} [fail_timeout=60] - set time in seconds to wait after failed connection to server in seconds
*/

/**
 * Initialize Countly object
 * @param {Init} conf - Countly initialization {@link Init} object with configuration options
 */
	Countly.init = function(ob){
		if(!inited){
            startTime = getTimestamp();
			inited = true;
			requestQueue = store("cly_queue") || [];
            timedEvents = store("cly_timed") || {};
			ob = ob || {};
            beatInterval = ob.interval || Countly.interval || beatInterval;
            failTimeoutAmount = ob.fail_timeout || Countly.fail_timeout || failTimeoutAmount;
            metrics = ob.metrics || Countly.metrics || {};
			Countly.debug = ob.debug || Countly.debug || false;
			Countly.app_key = ob.app_key || Countly.app_key || null;
			Countly.device_id = ob.device_id || Countly.device_id || getId();
			Countly.url = stripTrailingSlash(ob.url || Countly.url || "https://cloud.count.ly");
			Countly.app_version = ob.app_version || Countly.app_version || "0.0";
			Countly.country_code = ob.country_code || Countly.country_code || null;
			Countly.city = ob.city || Countly.city || null;
			Countly.ip_address = ob.ip_address || Countly.ip_address || null;
            log("Countly initialized");
			heartBeat();
			store("cly_id", Countly.device_id);
		}
	};
    
    /**
    * Start session
    * @param {boolean} noHeartBeat - true if you don't want to use internal heartbeat to manage session
    */
	
	Countly.begin_session = function(noHeartBeat){
		if(!sessionStarted){
			log("Session started");
			lastBeat = getTimestamp();
			sessionStarted = true;
			autoExtend = (noHeartBeat) ? false : true;
			var req = {};
			req.begin_session = 1;
			req.metrics = JSON.stringify(getMetrics());
			toRequestQueue(req);
		}
	};
	
    /**
    * Report session duration
    * @param {int} sec - amount of seconds to report for current session
    */
	Countly.session_duration = function(sec){
		if(sessionStarted){
			log("Session extended", sec);
			toRequestQueue({session_duration:sec});
		}
	};
	
    /**
    * End current session
    * @param {int} sec - amount of seconds to report for current session, before ending it
    */
	Countly.end_session = function(sec){
		if(sessionStarted){
            sec = sec || getTimestamp()-lastBeat;
			log("Ending session");
            reportViewDuration();
			sessionStarted = false;
			toRequestQueue({end_session:1, session_duration:sec});
            heartBeat();
		}
	};
	
    /**
    * Change current user/device id
    * @param {string} newId - new user/device ID to use
    * @param {boolean=} merge - move data from old ID to new ID on server
    **/
	Countly.change_id = function(newId, merge){
		var oldId = Countly.device_id;
		Countly.device_id = newId;
		store("cly_id", Countly.device_id);
		log("Changing id");
        if(merge)
            toRequestQueue({old_device_id:oldId});
	};
    
    /**
    * Countly custom event object
    * @typedef {Object} Event
    * @property {string} key - name or id of the event
    * @property {number} [count=1] - how many times did event occur
    * @property {number=} sum - sum to report with event (if any)
    * @property {number=} dur - duration to report with event (if any)
    * @property {Object=} segmentation - object with segments key /values
    */
	
    /**
    * Report custom event
    * @param {Event} event - Countly {@link Event} object
    **/
	Countly.add_event = function(event){
		if(!event.key){
			log("Event must have key property");
			return;
		}
		
		if(!event.count)
			event.count = 1;
		
		var props = ["key", "count", "sum", "dur", "segmentation"];
        var e = getProperties(event, props);
        e.timestamp = getTimestamp();
        var date = new Date();
        e.hour = date.getHours();
        e.dow = date.getDay();
		eventQueue.push(e);
		log("Adding event: ", event);
	};
    
    /**
    * Start timed event, which will fill in duration property upon ending automatically
    * @param {string} key - event name that will be used as key property
    **/
    Countly.start_event = function(key){
        if(timedEvents[key]){
            log("Timed event with key " + key + " already started");
            return;
        }
        timedEvents[key] = getTimestamp();
        store("cly_timed", timedEvents);
    };
    
    /**
    * End timed event
    * @param {string|Event} event - event key if string or Countly {@link Event} object
    **/
    Countly.end_event = function(event){
        if(typeof event == "string"){
            event = {key:event};
        }
        if(!event.key){
			log("Event must have key property");
			return;
		}
        if(!timedEvents[event.key]){
            log("Timed event with key " + key + " was not started");
            return;
        }
        event.dur = getTimestamp() - timedEvents[event.key];
        Countly.add_event(event);
        delete timedEvents[event.key];
        store("cly_timed", timedEvents);
    };
	
    /**
    * Countly user information object
    * @typedef {Object} UserDetails
    * @property {string=} name - user's full name
    * @property {string=} username - user's username or nickname
    * @property {string=} email - user's email address
    * @property {string=} organization - user's organization or company
    * @property {string=} phone - user's phone number
    * @property {string=} picture - url to user's picture
    * @property {string=} gender - M value for male and F value for femail
    * @property {number=} byear - user's birth year used to calculate current age
    * @property {Object=} custom - object with custom key value properties you want to save with user
    */
	
    /**
    * Report custom event
    * @param {UserDetails} user - Countly {@link UserDetails} object
    **/
	Countly.user_details = function(user){
		log("Adding userdetails: ", user);
		var props = ["name", "username", "email", "organization", "phone", "picture", "gender", "byear", "custom"];
		toRequestQueue({user_details: JSON.stringify(getProperties(user, props))});
	};
    
    /**
    * Report user conversion to the server (when user signup or made a purchase, or whatever your conversion is)
    * @param {string=} campaign_id - id of campaign, or will use the one that is stored after campaign link click
    * @param {string=} campaign_user_id - id of user's click on campaign, or will use the one that is stored after campaign link click
    **/
    Countly.report_conversion = function(campaign_id, campaign_user_id){
        if(campaign_id && campaign_user_id)
            toRequestQueue({campaign_id: campaign_id, campaign_user: campaign_user_id});
        else if(campaign_id)
            toRequestQueue({campaign_id: campaign_id});
        else
            log("No campaign data found");
    };
    
    /**************************
    * Modifying custom property values of user details
    * Possible modification commands
    *  - inc, to increment existing value by provided value
    *  - mul, to multiply existing value by provided value
    *  - max, to select maximum value between existing and provided value
    *  - min, to select minimum value between existing and provided value
    *  - setOnce, to set value only if it was not set before
    *  - push, creates an array property, if property does not exist, and adds value to array
    *  - pull, to remove value from array property
    *  - addToSet, creates an array property, if property does not exist, and adds unique value to array, only if it does not yet exist in array
    **************************/
    var customData = {};
    var change_custom_property = function(key, value, mod){
        if(!customData[key])
            customData[key] = {};
        if(mod == "$push" || mod == "$pull" || mod == "$addToSet"){
            if(!customData[key][mod])
                customData[key][mod] = [];
            customData[key][mod].push(value);
        }
        else
            customData[key][mod] = value;
    };
    
    /**
    * @namespace Countly.userData
    */
    Countly.userData = {
        /**
        * Sets user's custom property value
        * @param {string} key - name of the property to attach to user
        * @param {string|number} value - value to store under provided property
        **/
        set: function(key, value){
            customData[key] = value;
        },
        /**
        * Sets user's custom property value only if it was not set before
        * @param {string} key - name of the property to attach to user
        * @param {string|number} value - value to store under provided property
        **/
        set_once: function(key, value){
            change_custom_property(key, 1, "$setOnce");
        },
        /**
        * Increment value under the key of this user's custom properties by one
        * @param {string} key - name of the property to attach to user
        **/
        increment: function(key){
            change_custom_property(key, 1, "$inc");
        },
        /**
        * Increment value under the key of this user's custom properties by provided value
        * @param {string} key - name of the property to attach to user
        * @param {number} value - value by which to increment server value
        **/
        increment_by: function(key, value){
            change_custom_property(key, value, "$inc");
        },
        /**
        * Multiply value under the key of this user's custom properties by provided value
        * @param {string} key - name of the property to attach to user
        * @param {number} value - value by which to multiply server value
        **/
        multiply: function(key, value){
            change_custom_property(key, value, "$mul");
        },
        /**
        * Save maximal value under the key of this user's custom properties
        * @param {string} key - name of the property to attach to user
        * @param {number} value - value which to compare to server's value and store maximal value of both provided
        **/
        max: function(key, value){
            change_custom_property(key, value, "$max");
        },
        /**
        * Save minimal value under the key of this user's custom properties
        * @param {string} key - name of the property to attach to user
        * @param {number} value - value which to compare to server's value and store minimal value of both provided
        **/
        min: function(key, value){
            change_custom_property(key, value, "$min");
        },
        /**
        * Add value to array under the key of this user's custom properties. If property is not an array, it will be converted to array
        * @param {string} key - name of the property to attach to user
        * @param {string|number} value - value which to add to array
        **/
        push: function(key, value){
            change_custom_property(key, value, "$push");
        },
        /**
        * Add value to array under the key of this user's custom properties, storing only unique values. If property is not an array, it will be converted to array
        * @param {string} key - name of the property to attach to user
        * @param {string|number} value - value which to add to array
        **/
        push_unique: function(key, value){
            change_custom_property(key, value, "$addToSet");
        },
        /**
        * Remove value from array under the key of this user's custom properties
        * @param {string} key - name of the property
        * @param {string|number} value - value which to remove from array
        **/
        pull: function(key, value){
            change_custom_property(key, value, "$pull");
        },
        /**
        * Save changes made to user's custom properties object and send them to server
        **/
        save: function(){
            toRequestQueue({user_details: JSON.stringify({custom:customData})});
            customData = {};
        }
    };
    
    /**
    * Automatically track javascript errors that happen on the website and report them to the server
    * @param {string=} segments - additional key value pairs you want to provide with error report, like versions of libraries used, etc.
    **/
    Countly.track_errors = function(segments){
        crashSegments = segments;
        process.on('uncaughtException', function (err) {
            recordError(err, false);
            forceStore();
            console.error((new Date).toUTCString() + ' uncaughtException:', err.message);
            console.error(err.stack);
            process.exit(1);
        });
    };
    
    /**
    * Log an exception that you catched through try and catch block and handled yourself and just want to report it to server
    * @param {Object} err - error exception object provided in catch block
    * @param {string=} segments - additional key value pairs you want to provide with error report, like versions of libraries used, etc.
    **/
    Countly.log_error = function(err, segments){
        recordError(err, true, segments);
    };
    
    /**
    * Add new line in the log of breadcrumbs of what user did, will be included together with error report
    * @param {string} record - any text describing what user did
    **/
    Countly.add_log = function(record){
        crashLogs.push(record);
    };
    
    /**
    * Stop tracking duration time for this user
    **/
    Countly.stop_time = function(){
        trackTime = false;
        storedDuration = getTimestamp() - lastBeat;
        lastViewStoredDuration = getTimestamp() - lastViewTime;
    };
    
    /**
    * Start tracking duration time for this user, by default it is automatically tracked if you are using internal session handling
    **/
    Countly.start_time = function(){
        trackTime = true;
        lastBeat = getTimestamp() - storedDuration;
        lastViewTime = getTimestamp() - lastViewStoredDuration;
        lastViewStoredDuration = 0;
    };
    
	/**
	*  PRIVATE METHODS
	**/
    
    function reportViewDuration(){
        if(lastView){
            if(!platform)
                getMetrics();
            var segments = {
                "name": lastView,
                "segment":platform
            };

            //track pageview
            Countly.add_event({
                "key": "[CLY]_view",
                "dur": getTimestamp() - lastViewTime,
                "segmentation": segments
            });
            lastView = null;
        }
    }
	
	//insert request to queue
	function toRequestQueue(request){
        //ignore bots
        if(Countly.ignore_bots && isBot)
            return;
        
		if(!Countly.app_key || !Countly.device_id){
			log("app_key or device_id is missing");
			return;
		}
		
		request.app_key = Countly.app_key;
		request.device_id = Countly.device_id;
		
		if(Countly.country_code)
			request.country_code = Countly.country_code;
		
		if(Countly.city)
			request.city = Countly.city;
		
		if(Countly.ip_address !== null)
			request.ip_address = Countly.ip_address;
			
		request.timestamp = getTimestamp();
        var date = new Date();
        request.hour = date.getHours();
        request.dow = date.getDay();
		
		requestQueue.push(request);
		store("cly_queue", requestQueue, true);
	}
	
	//heart beat
	function heartBeat(){
		
		//extend session if needed
		if(sessionStarted && autoExtend && trackTime){
			var last = getTimestamp();
			if(last - lastBeat > 60){
				Countly.session_duration(last - lastBeat);
				lastBeat = last;
			}
		}
		
		//process event queue
		if(eventQueue.length > 0){
			if(eventQueue.length <= 10){
				toRequestQueue({events: JSON.stringify(eventQueue)});
				eventQueue = [];
			}
			else{
				var events = eventQueue.splice(0, 10);
				toRequestQueue({events: JSON.stringify(events)});
			}
		}
		
		//process request queue with event queue
		if(requestQueue.length > 0 && readyToProcess && getTimestamp() > failTimeout){
            readyToProcess = false;
            var params = requestQueue.shift();
            log("Processing request", params);
            makeRequest(params, function(err, params){
                log("Request Finished", params, err);
                if(err){
                    requestQueue.unshift(params);
                    failTimeout = getTimestamp() + failTimeoutAmount;
                }
                store("cly_queue", requestQueue, true);
                readyToProcess = true;
            });
		}
		
		setTimeout(heartBeat, beatInterval);
	}
	
	//get ID
	function getId(){
		var id = store("cly_id") || generateUUID();
		store("cly_id", id);
		return id;
	}
	
	//generate UUID
	function generateUUID() {
		var d = new Date().getTime();
		var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
			var r = (d + Math.random()*16)%16 | 0;
			d = Math.floor(d/16);
			return (c=='x' ? r : (r&0x3|0x8)).toString(16);
		});
		return uuid;
	}
	
	//get metrics of the browser
	function getMetrics(){
		var m = JSON.parse(JSON.stringify(metrics));
		
		//getting app version
		m._app_version = Countly.app_version;
        
        m._os = os.type();
        m._os_version = os.release();
        platform = os.type();
		
		log("Got metrics", m);
		return m;
	}
	
	//log stuff
	function log(){
		if(Countly.debug && typeof console !== "undefined"){
            if(arguments[1] && typeof arguments[1] == "object")
                arguments[1] = JSON.stringify(arguments[1]);
			console.log( Array.prototype.slice.call(arguments).join("\n") );
        }
	}
	
	//get current timestamp
	function getTimestamp(){
		return Math.floor(new Date().getTime() / 1000);
	}
    
    function recordError(err, nonfatal, segments){
        segments = segments || crashSegments;
        var error = "";
        if(typeof err === "object"){
            if(typeof err.stack !== "undefined")
                error = err.stack;
            else{
                if(typeof err.name !== "undefined")
                    error += err.name+":";
                if(typeof err.message !== "undefined")
                    error += err.message+"\n";
                if(typeof err.fileName !== "undefined")
                    error += "in "+err.fileName+"\n";
                if(typeof err.lineNumber !== "undefined")
                    error += "on "+err.lineNumber;
                if(typeof err.columnNumber !== "undefined")
                    error += ":"+err.columnNumber;
            }
        }
        else{
            error = err+"";
        }
        nonfatal = (nonfatal) ? true : false;
        var metrics = getMetrics();
        var ob = {_os:metrics._os, _os_version:metrics._os_version, _error:error, _app_version:metrics._app_version, _run:getTimestamp()-startTime};
        
        ob._not_os_specific = true;
        
        if(crashLogs.length > 0)
            ob._logs = crashLogs.join("\n");
        crashLogs = [];
        ob._nonfatal = nonfatal;
        
        if(typeof segments !== "undefined")
            ob._custom = segments;
        
        toRequestQueue({crash: JSON.stringify(ob)});
    }
	
	//sending xml HTTP request
	function makeRequest(params, callback) {
        try {
			log("Sending HTTP request");
            var options = {
                host: removeProtocol(Countly.url),
                path: apiPath+"?"+prepareParams(params),
                method: 'GET'
            };
            var protocol = http;
            if(Countly.url.indexOf("https") == 0)
                protocol = https;
            var req = protocol.request(options, function(res) {
                var str = ''
                res.on('data', function (chunk) {
                    str += chunk;
                });
            
                res.on('end', function () {
                    try{
                        str = JSON.parse(str);
                    }
                    catch(ex){
                        str = {}
                    }
                    if(res.statusCode >= 200 && res.statusCode < 300 && str.result == "Success"){
                        callback(false, params);
                    }
                    else{
                        callback(true, params);
                    }
                });
            });
            req.end();
        } catch (e) {
            // fallback
			log("Failed HTTP request", e);
            if (typeof callback === 'function') { callback(true, params); }
        }
    }
	
	//convert JSON object to query params
	function prepareParams(params){
		var str = [];
		for(var i in params){
			str.push(i+"="+encodeURIComponent(params[i]));
		}
		return str.join("&");
	}
	
	//removing trailing slashes
	function stripTrailingSlash(str) {
		if(str.substr(str.length - 1) == '/') {
			return str.substr(0, str.length - 1);
		}
		return str;
	}
    
    //removing protocol information from url
    function removeProtocol(str){
        return str.split("://").pop();
    }
	
	//retrieve only specific properties from object
	function getProperties(orig, props){
		var ob = {};
		var prop;
		for(var i = 0; i < props.length; i++){
			prop = props[i];
			if(typeof orig[prop] !== "undefined")
				ob[prop] = orig[prop];
		}
		return ob;
	}
    
    var __data = {};
    var dir = path.resolve(__dirname, filePath+'__data.json');
    
    try{
        __data = require(dir);
    } catch (ex) {
        console.log(ex);
        __data = {};
    }
    
    var forceStore = function(){
        fs.writeFileSync(dir, JSON.stringify(__data));
    };
	
	var store = function store(key, value) {
		// If value is detected, set new or modify store
		if (typeof value !== "undefined" && value !== null) {
			__data[key] = value;
            
            fs.writeFile(dir, JSON.stringify(__data), function (err) {
                if(err) {
                    return console.log(err);
                }
            });
		}
        else{
            return __data[key];
        }
	};
})(Countly);

module.exports = Countly;