FROM ubuntu

RUN apt-get update && apt-get install -y nodejs ca-certificates
ADD . /opt/dns

ENV DEBUG dns:marathon,dns:route53,dns
CMD ["/usr/bin/nodejs", "/opt/dns/dns.js"]
