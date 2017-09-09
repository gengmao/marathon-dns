var http = require("http"),
    url = require("url"),
    util = require("util"),
    AWS = require("aws-sdk"),
    dns = require("dns"),
    Q = require("q"),
    Marathon = require("./lib/marathon.js"),
    utils = require("./lib/utils.js"),
    debug = require("debug")("dns");

debug.marathon = require("debug")("dns:marathon");
debug.route53 = require("debug")("dns:route53");

// Connect to AWS
AWS.config.region = process.env.AWS_REGION || "us-east-1";
if (process.env.AWS_ACCESS_KEY && process.env.AWS_SECRET_KEY) {
	AWS.config.credentials = {
		accessKeyId: process.env.AWS_ACCESS_KEY,
		secretAccessKey: process.env.AWS_SECRET_KEY
	};
}

// Create Route53 client
var route53  = new AWS.Route53();
var marathon = new Marathon({base_url: process.env.MARATHON_HOST});

var marathonPollInterval = process.env.MARATHON_POLL_INTERVAL || 30000;
var listenPort = process.env.PORT || 8053;
var recordTTL = process.env.RECORD_TTL || 60;
var defaultDnsScope = process.env.DEFAULT_DNS_SCOPE || 'external';

var state = null;
var stateTable = null;

setInterval(function(){
	marathon.apps.list().then(function(res) {
		var targets = [];

		debug.marathon('querying marathon apps');
		res.apps.forEach(function(app){
			if (typeof app.env['DNS'] != 'undefined') {
				targets.push({
					id: app.id,
					dns: app.env['DNS'],
					dns_scope: app.env['DNS_SCOPE'] || defaultDnsScope
				});
			}
		});
		return targets;
	}).then(function(apps){
		var q = Q.defer()
		debug.marathon('querying marathon tasks');
		marathon.tasks.list().then(function(res){
			var records = [];
			res.tasks.forEach(function(task) {
				for(var i=0; i < apps.length; ++i){
					var app = apps[i];
					if (app.id != task.appId) {
						continue;
					}

					debug.marathon('detected task addr: ' + app.dns + '@' + task.host);
					records.push({
						name: app.dns,
						host: task.host,
						dns_scope: app.dns_scope
					})
				}
			});

			q.resolve(records);
		});
		return q.promise;
	}).then(function(records){
		update(records);
	}).fail(function(err){
		debug(err);
	});

}, marathonPollInterval);


// Update route53
function update(records){
	// Add the IP Addresses to the table
	buildTable(records).then(function(t){
		// Quick comparison of the tables to avoid additional calls to Route53
		var t0 = stateTable;
		var t1 = utils.clone(t);
		stateTable = t1;

		// Compare now
		if(JSON.stringify(t0) == JSON.stringify(t1)){
			debug('no changes detected');
			return;
		}

		// Retrieve the hosted zones
		var q = Q.defer();
		debug.route53('retrieving route53 hosted zones');
		route53.listHostedZones({}, function(err, data){
			if (err) return q.reject(err);
			return q.resolve({table: t, zones: data});
		});
		return q.promise;
	}).then(function(data){
		// We must have a data to proceed
		if(typeof data === 'undefined' || data == null)
			return;

		// Group by zone for Route53
		var groupByZone = {};
		for(var name in data.table){

			// Find the appropriate hosting zone (must exist)
			for(var i=0; i< data.zones.HostedZones.length; ++i){
				var hostedZone = data.zones.HostedZones[i];
				if(name.endsWith(hostedZone.Name.slice(0,-1))){
					if(typeof groupByZone[hostedZone.Name] === 'undefined'){
						groupByZone[hostedZone.Name] = {
							id: hostedZone.Id,
							rec: [],
							del: []
						}
					}

					delete data.table[name]['resolve'];
					groupByZone[hostedZone.Name].rec.push({
						name: name,
						records: data.table[name]
					});
					break;
				}
			}
		}

		// Compare current and previous states, modifying it
		var current = utils.diff(utils.clone(state), utils.clone(groupByZone));
		state = utils.clone(groupByZone);

		// Update the records
		for(var zoneName in current){
			var zone = current[zoneName];
			updateRecords(zone).then(function(){
				debug.route53('updated ' + zoneName);
			})
			.fail(function(err){
				debug.route53(err);
			});
		}
	})
	.fail(function(err){
		debug.route53(err);
	});
}


// Updates a single hosted zone 
function updateRecords(zone){
	var q = Q.defer();
	var changes = [];

	// Create the list of records
	zone.rec.forEach(function(change){
		var recordSet = [];
		var addresses = utils.distinct(change.records.addr);
		addresses.forEach(function(addr){
			recordSet.push({
				Value: addr
			})
		});

		debug.route53('changing ' + change.name + " to " +addresses);
		changes.push({
			Action: 'UPSERT',
			ResourceRecordSet: {
				Name: change.name, 
				Type: 'A',
				ResourceRecords: recordSet,
				TTL: recordTTL
			}
		});
	});

	// Create the list of deletions
	zone.del.forEach(function(deletion){
		var recordSet = [];
		var addresses = utils.distinct(deletion.records.addr);
		addresses.forEach(function(addr){
			recordSet.push({
				Value: addr
			})
		});

		debug.route53('deleting ' + deletion.name);
		changes.push({
			Action: 'DELETE',
			ResourceRecordSet: {
				Name: deletion.name, 
				Type: 'A',
				ResourceRecords: recordSet,
				TTL: recordTTL
			}
		});
	});

	// Prepare the request
	var request = {
		HostedZoneId: zone.id,
		ChangeBatch: {
			Changes: changes
		}
	};

	// Send the request
	debug.route53('changing resource record sets: ' + zone.id);
	route53.changeResourceRecordSets(request, function(err, data) {
		if(err) {
			debug.route53(err);
			return q.reject(err);
		}
		return q.resolve()
	});

	return q.promise;
}

// Build a dns table from the records provided
function buildTable(records){	
	var table = {};

	// Create the records in the table
	records.forEach(function(record) {
		record.name = (record.name.indexOf('://') != -1) 
			? url.parse(record.name).hostname
			: record.name;

		if (typeof table[record.name] === 'undefined') {
			table[record.name] = {
				name: record.name,
				resolve: [],
				addr: []
			};
		}

		// Push resolve functions
		if (record.dns_scope == 'internal') {
			table[record.name].resolve.push(utils.ipv4(record.host));
		} else {
			table[record.name].resolve.push(utils.ec2Ipv4(record.host));

			if (record.dns_scope == 'dual') {
				var internalName = 'internal-' + record.name;
				if (typeof table[internalName] === 'undefined') {
					table[internalName] = {
						name: internalName,
						resolve: [],
						addr: []
					};
				}

				table[internalName].resolve.push(utils.ipv4(record.host));
			}
		}
	});

	// Resolve each record
	var q = [];
	for(var name in table){
		debug.route53('resolving records for address: ' + name);
		table[name].resolve.forEach(function(promise) {
			q.push(promise);
		})
	}

	return Q.allSettled(q).then(function(results){
		for(var name in table){
			var requests = table[name].resolve;
			for(var i=0; i< requests.length; ++i){
				var request = requests[i];
				if(request.isFulfilled()){
					var value = request.inspect().value;
					debug(name + ' => ' + value);
					value.forEach(function(addr){
						// If we have an array, iterate through
						if( Object.prototype.toString.call( addr ) === '[object Array]' ) {
							addr.forEach(function(subAddr){
								table[name].addr.push(subAddr);
							});
						}

						// Single address
						if( typeof addr === 'string' ){
							table[name].addr.push(addr);
						}
					})
				}
			}
		}

		return table;
	}).fail(function(err){
		debug(err);
	});
}

// Start the server
http.createServer(function (req, res) {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.write(JSON.stringify(state));
  res.end();
}).listen(listenPort);
