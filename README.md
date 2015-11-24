# Marathon DNS Service Discovery
### Service Discovery with AWS Route53, Mesos, Marathon & Docker

Marathon DNS is a forked version of Misakai.Dns which takes advantage of AWS Route53 DNS service and Mesos Marathon to automatically register the applications deployed with Marathon to Route53 DNS. This build creates a Docker image you can deploy in ec2 with configuration being managed on per-app basis using *environment variables*.

It is *recommended* to launch marathon-dns into your cluster using Marathon for availability. You will need only one instance of the DNS running, since it simply queries both Marathon and AWS Route53.

The following env variables are available for configuration:
  - AWS_REGION
  - AWS_ACCESS_KEY (required)
  - AWS_SECRET_KEY (required)
  - MARATHON_HOST (required)
  - MARATHON_AUTH
  - MARATHON_POLL_INTERVAL
  - DEFAULT_DNS_SCOPE
  - RECORD_TTL
  - PORT
  - DNS

# Using marathon dns
Any marathon application with an env variable of `DNS` defined will have a round robin dns entry created in route53 using the domain name as the zone. Each dns record is processed with a corresponding scope which determines how the record values are processed/resolved. Marathon applications may define an env variable of `DNS_SCOPE` to specify a non-default value, the supported dns record scopes are:
  - `external` (default) - The mesos slave hostname is resolved as a cname which is expected to return a value containing a public ec2 hostname (`ec2-xx-xx-xx-xx.compute-1.amazonaws.com`) which the public ipv4 address is parsed from.
  - `internal` - The marathon dns service is expected to be run on an ec2 host and as a result internal dns records are resolved normally.
  - `dual` - An external dns address is created at the configured name and an additional internal address is created with a `internal-` prefix.
