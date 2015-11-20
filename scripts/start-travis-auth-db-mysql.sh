#!/usr/bin/env bash

set -ev

node ./scripts/gen_keys.js
node ./node_modules/fxa-auth-db-mysql/bin/db_patcher.js
node ./node_modules/fxa-auth-db-mysql/bin/server.js & 

# give auth-db-mysql a moment to start up
sleep 5
