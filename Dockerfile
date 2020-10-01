FROM node:latest AS builder

WORKDIR /opt/mx-puppet-linkedin

# run build process as user in case of npm pre hooks
# pre hooks are not executed while running as root
RUN chown node:node /opt/mx-puppet-linkedin
USER node

COPY package.json yarn.lock tsconfig.json ./
COPY src/ ./src/
RUN npm install
RUN npm run build

FROM node:alpine

VOLUME /data

ENV CONFIG_PATH=/data/config.yaml \
    REGISTRATION_PATH=/data/linkedin-registration.yaml

# su-exec is used by docker-run.sh to drop privileges
# util-linux includes the 'whereis' command
RUN apk add --update --no-cache su-exec python3 python3-dev util-linux
RUN pip3 install linkedin_api click

WORKDIR /opt/mx-puppet-linkedin
COPY docker-run.sh ./
COPY --from=builder /opt/mx-puppet-linkedin/node_modules/ ./node_modules/
COPY --from=builder /opt/mx-puppet-linkedin/dist/ ./dist/

# change workdir to /data so relative paths in the config.yaml
# point to the persisten volume
WORKDIR /data
RUN chmod 777 /opt/mx-puppet-linkedin/docker-run.sh
ENTRYPOINT ["/opt/mx-puppet-linkedin/docker-run.sh"]