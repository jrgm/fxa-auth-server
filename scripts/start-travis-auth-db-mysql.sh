#!/usr/bin/env bash

set -ev

node ./scripts/gen_keys.js

# force install of mysql-patcher
(cd node_modules/fxa-auth-db-mysql && npm install)

mysql -e 'DROP DATABASE IF EXISTS fxa'
node ./node_modules/fxa-auth-db-mysql/bin/db_patcher.js

nohup node ./node_modules/fxa-auth-db-mysql/bin/server.js &>/var/tmp/db-mysql.out & 

# give auth-db-mysql a moment to start up
sleep 5

# this will cause a test fail if no response
# TODO: when available, check that implementation is 'MySql'
curl http://127.0.0.1:8000/
