#!/usr/bin/env bash

node ./scripts/gen_keys.js

ls ./node_modules/fxa-auth-db-mysql/bin/db_patcher.js || npm i ./node_modules/fxa-auth-db-mysql
node ./node_modules/fxa-auth-db-mysql/bin/db_patcher.js
node ./node_modules/fxa-auth-db-mysql/bin/server.js
