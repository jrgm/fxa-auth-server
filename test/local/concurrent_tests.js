/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var test = require('../ptaptest')
var TestServer = require('../test_server')
var Client = require('../client')
var P = require('../../lib/promise')


process.env.VERIFIER_VERSION = '1'
var config = require('../../config').root()

TestServer.start(config)
.then(function main(server) {

  test(
    'concurrent create requests',
    function (t) {
      var email = server.uniqueEmail()
      var password = 'abcdef'
      // Two shall enter, only one shall survive!
      return P.all(
        [
          Client.create(config.publicUrl, email, password, server.mailbox),
          Client.create(config.publicUrl, email, password, server.mailbox)
        ]
      )
      .then(
        t.fail.bind(t, 'created both accounts'),
        function (err) {
          t.equal(err.errno, 101, 'account exists')
        }
      )
    }
  )

  test(
    'teardown',
    function (t) {
      server.stop()
      t.end()
    }
  )
})
