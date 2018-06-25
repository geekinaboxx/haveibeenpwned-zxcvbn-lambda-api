﻿'use strict'
import '@babel/polyfill'
import axios from 'axios'
import bodyParser from 'body-parser'
import cors from 'cors'
import crypto from 'crypto'
import express from 'express'
import fs from 'fs'
import helmet from 'helmet'
import lru from 'tiny-lru'
import path from 'path'
import shortid from 'shortid'
import zxcvbn from 'zxcvbn'

let prod

if (process.env.DEV_SERVER) {
  prod = false
  // Set environment vars from dev.env.json for a dev server
  const environment = JSON.parse(
    fs.readFileSync(__dirname + '/../dev.env.json')
  )
  for (let [key, value] of Object.entries(environment)) {
    process.env[key] = value
  }
} else {
  prod = true
  // Set env to production for use in Lambda
  process.env.NODE_ENV = 'production'
}

// Logs requests in development
function logg(stuff) {
  return prod ? void 0 : console.info(stuff)
}

// Main express instance
const app = express()

// Parse incoming body content as JSON
app.use(bodyParser.json())

// Cross-Origin-Resource-Sharing
const corsOptions = {
  origin:
    process.env.ALLOW_ORIGINS && process.env.ALLOW_ORIGINS.includes(',')
      ? process.env.ALLOW_ORIGINS.split(',')
      : '*',
  maxAge: process.env.CORS_MAXAGE ? +process.env.CORS_MAXAGE : 0,
}

app.use(cors(corsOptions))

// Use headers from reverse proxies as remote source
app.enable('trust proxy')

// Basic security headers
app.use(helmet())

// Router instance
const router = express.Router()

// Set the scoring endpoint
const endpoint = path.normalize(
  `/` + (process.env.SCORING_ENDPOINT || '/_score')
)

// Set the API route prefix
const routePrefix = process.env.ROUTE_PREFIX || `/`

// create a mini cache of max 1000 entries, ignore events, expire entries after 5 minutes
// but auto-renew entry ttl whenever accessed
const cache = lru(1e3, false, 3e5)

/*
   BEGIN ROUTES 🚀
 */

// Health check and/or warm-up endpoint for the function container
router.get('/_up', (req, res) => res.status(200).json({ ok: true }))

// Password scoring and haveibeenpwned crosscheck endpoint
router.post(endpoint, async (req, res) => {
  let ok, score, message
  let cancel = false

  const id = prod ? void 0 : shortid()

  const { password } = req.body

  // AbortController for cancelling request
  const CancelToken = axios.CancelToken
  const source = CancelToken.source()

  req.on('close', () => {
    cancel = true
    logg(`${id}: ABORTED - abandon ship!`)
    try {
      source.cancel(`Connection closed`)
    } catch (err) {
      void err
    }
  })

  if (!password || typeof password !== 'string' || !password.length) {
    //
    // something's wrong with the input - bail!
    return cancel
      ? void 0
      : res.status(400).json({
          ok: false,
          message: `'password' must be a string of length > 0`,
        })
  }

  // first, check the cache
  const cachedResult = cache.get(password)

  if (cachedResult) {
    // hit! send cached result, entry ttl has been auto-renewed
    res.set('x-cached-result', 1)
    return cancel ? null : res.status(200).json(cachedResult)
  }

  // nope, not in cache
  res.set('x-cached-result', 0)

  // execute scoring and range search in parallel
  let [strength, pwned] = cancel
    ? [null, null]
    : await Promise.all([zxcvbn(password), pwnedPassword(password)]).catch(
        err => {
          // something went kaputt :( log it
          console.error(err)

          message = err.message || 'Unknown error'

          // you get nothing! good day, sir!
          return Array(2)
        }
      )

  // validate the results
  ok = strength.hasOwnProperty('score') && Number.isSafeInteger(pwned)

  if (ok) {
    score = strength.score
    // if already pwned, set score to zero unless overridden
    if (pwned && process.env.ALWAYS_RETURN_SCORE !== 'true') score = 0

    // cache our funky-fresh results
    cache.set(password, { ok, score, pwned })
  }

  return cancel ? null : res.status(200).json({ ok, score, pwned, message })

  // Range-search input against pwnedpasswords
  async function pwnedPassword(pw) {
    // Util for creating a pwndpasswords range query URL
    const pwnedUrl = p => `https://api.pwnedpasswords.com/range/${p}`

    const hash = Array.from(
      await crypto
        .createHash('sha1')
        .update(pw)
        .digest('hex')
        .toUpperCase()
    )
    const prefix = hash.splice(0, 5).join('')
    const suffix = hash.join('')

    logg(`${id}: Sending range search request`)

    let result = cancel
      ? null
      : await axios({
          url: pwnedUrl(prefix),
          method: 'GET',
          cancelToken: source.token,
        })
          .then(result => result.data)
          .catch(err => {
            if (axios.isCancel(err)) {
              return logg(`${id}: Range search aborted`)
            }
            // Something's goofy - bail!
            throw err
          })

    if (!result) return null

    logg(`${id}: Range search complete`)

    if (!result.includes(suffix)) {
      return 0
    }

    result = result.split('\r\n')
    const match = result.find(r => r.includes(suffix))
    return +match.split(':')[1]
  }
})

/*
   END ROUTES 🚧
 */

// Prefix routes with our selected route...prefix
app.use(path.normalize(`/` + routePrefix), router)

if (process.env.DEV_SERVER) {
  // start a development server if that's what we're up to
  const port = +process.env.DEV_SERVER_PORT || 3000

  app.listen(port, err => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    logg(`Development server up on port ${port}`)
  })
} else {
  // export for use as a Lambda function request handler
  module.exports = app
}
