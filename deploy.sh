#!/bin/bash

VERSION=$(cat package.json | jq '.version' | sed -e 's/^"//' -e 's/"$//')

# npm publish .

docker build --no-cache -t scottcrossen/mx-puppet-linkedin:latest . -t scottcrossen/mx-puppet-linkedin:"$VERSION" || exit
docker push scottcrossen/mx-puppet-linkedin:latest
docker push scottcrossen/mx-puppet-linkedin:"$VERSION"