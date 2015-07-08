#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// NOTE: this script will fail if run against official production
// auth-server, since `/v1/account/lock` is, of course, not available
// there.

const assert = require('assert')
const crypto = require('crypto')
const url = require('url')

const P = require('../../lib/promise')
const preq = require('./p-request')
const localeQuirks = require('./localeQuirks')
var Client = require('../../test/client')

const password = crypto.randomBytes(32).toString('hex')

var program
try {
  program = require('commander')
} catch(e) {
  console.log('This program requires you to do `npm install commander` first.')
  process.exit(1)
}

program
  .option('-a, --auth-server [url]',
          'URL of FxA Auth Server',
          'https://api-accounts.stage.mozaws.net')
  .option('-r, --restmail-domain [fqdn]',
          'URL of the restmail server',
          'restmail.net')
  .option('-L, --locale <en[,zh-TW,de,...]>',
          'Test only this csv list of locales',
          function(list) {
            return list.split(/,/)
          })
  .option('-m, --max-locales [int]', // useful for smoketest and debugging
          'Only send find email for first M locales [Infinity]',
          parseInt, Infinity)
  .option('-b, --basename [string]',
          'Base username for this test run',
          crypto.randomBytes(8).toString('hex'))
  .parse(process.argv)

const VERIFY_PATH = '/v1/verify_email'
const RESET_PATH = '/v1/complete_reset_password'
const UNLOCK_PATH = '/v1/complete_unlock_account'

const supportedLanguages = program.locale ||
  require(program.locales).slice(0, program.maxLocales)

function log(level /*, rest */) {
  if (level < log.level) return
  var args = Array.prototype.slice.call(arguments)
  var timestamp = '[' + new Date().toISOString() + ']'
  args[0] = timestamp
  console.log.apply(null, args)
}
log.ERROR = 3
log.INFO = 2
log.DEBUG = 1
log.level = log.INFO

function langFromEmail(email) {
  // is like 'deadbeef-es@...' or 'deadbeef-es-AR@...'
  return email.split('@')[0].match(/^[^-]*-([^-]*(?:-[^-]*)?)/)[1]
}

function assertHeader(headers, key) {
  assert.ok(headers[key], 'received ' + key + ' header')
}

function assertSubjectLang(subject, lang, expectSubject) {
  // If it's listed in quirks, expect en-US content
  var quirks = localeQuirks[expectSubject]
  if (quirks && quirks[lang]) {
    assert.equal(subject, expectSubject, lang + ' -> ' + subject)
  } else {
    assert.notEqual(subject, expectSubject, lang + ' -> ' + subject)
  }
}

function checkSubjects(subject, lang, headers, link) {
  function checkByType(expectedSubject, xheaders, params) {
    assertSubjectLang(subject, lang, expectedSubject)

    xheaders.forEach(function(header) {
      assertHeader(headers, header)
    })

    var actual = JSON.stringify(Object.keys(link.query).sort())
    assert.equal(actual, params, 'received expected keys')
  }

  if (link.pathname === VERIFY_PATH) {
    checkByType('Verify your Firefox Account', ['x-verify-code', 'x-uid'], '["code","uid"]')
  } else if (link.pathname === RESET_PATH) {
    checkByType('Reset your Firefox Account password', ['x-recovery-code'], '["code","email","token"]')
  } else if (link.pathname === UNLOCK_PATH) {
    checkByType('Re-verify your Firefox Account', ['x-unlock-code', 'x-uid'], '["code","uid"]')
  }
}

function verifyMailbox(mbox, log) {
  assert.equal(mbox.length, 3, 'mailbox has 3 messages')

  var lang = langFromEmail(mbox[0].headers.to)
  var subject = mbox[0].headers.subject
  mbox.lang = lang

  log(log.INFO, 'Checking mail message received for:', lang, subject)

  var emailTypes = {}
  var maxDeliveryTime = 0

  mbox.forEach(function(mail) {
    var expectedHeaders = [
      'to',
      'from',
      'date',
      'subject',
      'x-link',
      'content-language',
      'dkim-signature'
    ]

    expectedHeaders.forEach(function(key) {
      assertHeader(mail.headers, key)
    })

    var headers = mail.headers

    var fromTime = new Date(headers.date).getTime()
    var recvTime = new Date(mail.receivedAt).getTime()
    var deliveryTime = recvTime - fromTime
    if (deliveryTime > maxDeliveryTime) {
      maxDeliveryTime = deliveryTime
    }

    var lang = langFromEmail(headers.to)
    var quirks = localeQuirks['content-language']
    if (quirks[lang]) {
      assert.equal('en-US', headers['content-language'],
                     'content-language header is en-US')
    } else {
      // See https://github.com/mozilla/fxa-content-server-l10n/issues/44 about sr-LATN
      if (lang !== 'sr-LATN') {
        assert.equal(lang, headers['content-language'],
                     'content-language header is locale specific')
      }
    }

    assert.notEqual(mail.html.length, 0, 'mail message html has zero length')
    assert.notEqual(mail.text.length, 0, 'mail message text has non-zero length')

    var subject = headers.subject
    var link = url.parse(headers['x-link'], true)
    emailTypes[link.pathname] += 1

    checkSubjects(subject, lang, headers, link)
  })

  assert.equal(Object.keys(emailTypes).length, 3, 'got verify, reset and unlock emails')

  // add delivery time so it can be checked in aggregate
  mbox.maxDeliveryTime = maxDeliveryTime

  return mbox
}

function emailFromLang(lang) {
  return program.basename + '-' + lang + '@' + program.restmailDomain
}

function argsFromLang(lang, withPassword) {
  var args = {
    email: emailFromLang(lang),
  }
  if (withPassword) {
    args.authPW = password
  }
  return args
}

function createRequestOptions(lang, path) {
  var options = {
    url: url.resolve(program.authServer, path),
    headers: {
      'accept-language': lang
    }
  }
  return options
}

function createRequest(path, useAuthPW) {
  return function(result) {
    var lang = result.req._headers['accept-language']
    var args = argsFromLang(lang, useAuthPW)
    var options = createRequestOptions(lang, path)

    log(log.INFO, 'Starting request:', lang, path)

    return preq.post(options, args)
  }
}

/*

  - signup for service sync
  - CHECK the email; use the link to confirm
  - signin, as if second device
  - CHECK that I get a notification email of a second device
  - change the password
  - CHECK that I get a notification email of a password change
  - trigger a password reset
  - CHECK that I get a password reset email
  - use the reset email link to complete the password reset
  - CHECK that I get a notification email of a password reset
  - trigger an account lock
  - trigger an account unlock
  - CHECK that I get an unlock email (but it's moot if I unlock a test account)

*/

function fetchMailbox(lang, expect) {
  function resultComplete(res) {
    return res.body && res.body.length === expect
  }

  var restmail = 'http://' + program.restmailDomain + '/mail/'
  var options = {
    url: restmail + program.basename + '-' + lang,
    complete: resultComplete,
    progress: log.bind(null, log.level)
  }

  // Briefly delay in order to allow SMTP to happen, and not trigger
  // unnecessary retries; `preq.get` will handle any actual subsequent
  // need to retry.
  return P.delay(1000).then(function() {
    return preq.get(options)
      .then(function(mailbox) {
        return {
          lang: lang,
          mailbox: mailbox
        }
      })
  })
}

function signupForSync(lang) {
  var path = '/v1/account/create'
  var options = {
    url: url.resolve(program.authServer, path),
    headers: {
      'accept-language': lang
    }
  }
  var args = {
    email: emailFromLang(lang),
    authPW: password,
    service: 'sync'
  }

  var sessionToken, uid
  
  return preq.post(options, args)
    .then(function(result) {
      sessionToken = result.body.sessionToken
      uid = result.body.uid
    })
    .then(function() {
      return fetchMailbox(lang, 1)
    })
}

function completeSignup(state) {
  var lang = state.lang
  var email = state.mailbox[0]
  var headers = email.headers

  var options = {
    url: url.resolve(program.authServer, '/v1/recovery_email/verify_code'),
    progress: log.bind(null, log.level),
    headers: {
      'accept-language': lang
    }
  }

  var args = {
    uid: headers['x-uid'],
    code: headers['x-verify-code']
  }
  
  return preq.post(options, args)
    .then(function(res) {
      return {
        lang: lang,
        res: res
      }
    })
}

function signinAsSecondDevice(state) {
  var lang = state.lang

  var options = {
    url: url.resolve(program.authServer, '/v1/account/login'),
    progress: log.bind(null, log.level),
    headers: {
      'accept-language': lang
    }
  }

  var args = {
    email: emailFromLang(lang),
    authPW: password,
    service: 'sync',
    reason: 'signin'
  }
  
  return preq.post(options, args)
    .then(function(res) {
      return {
        lang: lang,
        res: res
      }
    })
}

function confirmSecondDeviceNotification(state) {
  return fetchMailbox(state.lang, 2)
    .then(function(state) {
      var lang = state.lang
      var mailbox = state.mailbox
      var email = mailbox[1]
      var headers = email.headers
      var link = headers['x-link']

      var subjectEn = 'A new device is now syncing to your Firefox Account'
      if (lang == 'en' || lang == 'en-US') {
        //
      } else {
      }

      // In a non-en locale, the closest I can come to confirming that this is
      // the right email content is that it should have a reset link.
      if (! link.match(/\/v1\/reset_password\?email=/)) {
        console.log(link, 'is not for reset_password') // XXX
      }

      return state
    })
}

function changePassword(state) {
  var lang = state.lang
  var email = emailFromLang(lang)
  debugger
  return Client.changePassword(program.authServer, email, password, password)
    .then(function (rv) {
      debugger
    })
}

function confirmPasswordChangeNotification(state) {}
function startPasswordReset(state) {}
function completePasswordReset(state) {}
function confirmPasswordResetNotification(state) {}
function forceAccountLock(state) {
  // Note: /account/lock is not available in production
}
function startAccountUnlock(start) {}
function confirmUnlock(start) {}

function checkLocale(lang, index) {
  var args = argsFromLang(lang, true)

  // AWS SES in stage has rate-limiting in stage of 5/sec, so go slow
  var delay = index * 750

  return P.delay(delay)
    .then(
      function() {
        log(log.INFO, 'Kicking off', lang)

        return signupForSync(lang)
          .then(completeSignup)
          .then(signinAsSecondDevice)
          .then(confirmSecondDeviceNotification)
          .then(changePassword)
          .then(confirmPasswordChangeNotification)
          .catch(
            function(err) {
              log(log.ERROR, err)
            }
          )
      }
    )
}

function main() {
  supportedLanguages.forEach(checkLocale)
}

main()
