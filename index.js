const config = require('config')
const fs = require('fs')
const express = require('express')
const spdy = require('spdy')
const cors = require('cors')
const sharp = require('sharp')
const Queue = require('better-queue')
const genericPool = require('generic-pool')
const MBTiles = require('@mapbox/mbtiles')
const mbgl = require('@mapbox/mapbox-gl-native')
const vtpbf = require('vt-pbf')
const mapnik = require('mapnik')
const zlib = require('zlib')

const farms = require(config.get('farmsPath'))
const cert = fs.readFileSync(config.get('certPath'))
const key = fs.readFileSync(config.get('keyPath'))
const port = config.get('port')
const htdocsPath = config.get('htdocsPath')
const stylePath = config.get('stylePath')
const spriteJsonPath = config.get('spriteJsonPath')
const spritePngPath = config.get('spritePngPath')
const fontsDir = config.get('fontsDir')

const emptyTile = vtpbf({ features: [] })
const etag = 'a'

let mbtilesPool = {}

const tile2long = (x, z) => {
  return x / 2 ** z * 360 - 180
}

const tile2lat = (y, z) => {
  const n = Math.PI - 2 * Math.PI * y / 2 ** z
  return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}

mbgl.on('message', msg => {
  console.log(msg)
})

const app = express()
app.use(cors())
app.use(express.static(htdocsPath))

const openMbtiles = (mbtilesPath) => {
  return new Promise((resolve, reject) => {
    new MBTiles(`${mbtilesPath}?mode=ro`, (err, mbtiles) => {
      if (err) reject(err)
      resolve(mbtiles)
    })
  })
}

const getEachTile = (mbtiles, z, x, y) => {
  return new Promise((resolve, reject) => {
    mbtiles.getTile(z, x, y, (err, tile, headers) => {
      if (err) reject(err)
      resolve(tile)
    })
  })
}

const getConcatenatedTile = (z, x, y) => {
  return new Promise(async (resolve, reject) => {
    let contents = []
    let keys = []
    for (let key in farms) {
      const mbtilesPath = farms[key].getMbtilesPath(z, x, y)
      let mbtiles = mbtilesPool[mbtilesPath]
      if (!mbtiles) {
        try {
          mbtiles = mbtilesPool[mbtilesPath] = openMbtiles(mbtilesPath)
        } catch (e) {
          console.error(e)
          continue
        }
      }
      try {
        // console.log(`${z}/${x}/${y} from ${mbtilesPath}`)
        let t = new mapnik.VectorTile(z, x, y)
        t.addDataSync(
          await getEachTile(await mbtiles, z, x, y),
          { validate: true })
        contents.push(t)
        keys.push(key)
      } catch (e) {
        // This is the case where tile does not exist.
        // console.error(e)
        continue
      }
    }

    if (keys.length > 0) {
      let vectorTile = new mapnik.VectorTile(z, x, y)
      vectorTile.compositeSync(contents)
      resolve(vectorTile.getData({ compression: 'gzip' }))
    } else {
      reject(new Error(`${z}/${x}/${y} not found`))
    }
  })
}

const createResponse = data => {
  return {
    modified: new Date(),
    expires: new Date(),
    etag: etag,
    data: data
  }
}

const getFont = async (url) => {
  return new Promise((resolve, reject) => {
    let r = url.split('/')
    let fontstack = r[r.length - 2]
    let range = r[r.length - 1].split('.')[0]
    const fontPath = `${fontsDir}/${fontstack}/${range}.pbf`
    fs.readFile(fontPath, (err, data) => {
      if (err) {
        reject(err)
      } else {
        resolve(data)
      }
    })
  })
}

const getTile = (url) => {
  return new Promise((resolve, reject) => {
    let r = url.split('/')
    const z = parseInt(r[r.length - 3])
    const x = parseInt(r[r.length - 2])
    const y = parseInt(r[r.length - 1].split('.')[0])
    getConcatenatedTile(z, x, y).then(tile => {
      resolve(zlib.gunzipSync(tile))
    }).catch(e => {
      resolve(emptyTile)
    })
  })
}

const mbglRequestQueue = new Queue((req, cb) => {
  switch (req.kind) {
    case 6:
      fs.readFile(spriteJsonPath, (err, data) => {
        if (err) cb(err)
        cb(null, data)
      })
      break
    case 5:
      fs.readFile(spritePngPath, (err, data) => {
        if (err) cb(err)
        cb(null, data)
      })
      break
    case 4:
      getFont(req.url).then(data => {
        cb(null, data)
      })
      break
    case 3:
      getTile(req.url).then(tile => {
        cb(null, tile)
      })
      break
    default:
  }
}, { concurrent: 6 })

const maps = genericPool.createPool({
  create: function () {
    const map = new mbgl.Map({
      request: (req, cb) => {
        mbglRequestQueue.push(req, (err, data) => {
          if (err) cb(err)
          cb(null, createResponse(data))
        })
      },
      mode: 'tile'
    })
    map.load(require(stylePath))
    return map
  },
  destroy: function (map) {
    map.release()
  }
}, {
  max: 10,
  min: 2
})

const tileQueue = new Queue((r, cb) => {
  const [z, x, y] = [r.z, r.x, r.y]
  const center = [ tile2long(x + 0.5, z), tile2lat(y + 0.5, z) ]

  maps.acquire().then(map => {
    map.render({
      zoom: z,
      center: center,
      width: z > 2 ? 1024 : 512,
      height: z > 2 ? 1024 : 512
    }, (err, buffer) => {
      maps.release(map)
      if (err) return cb(err)
      let image = sharp(buffer, {
        raw: {
          width: z > 2 ? 1024 : 512,
          height: z > 2 ? 1024 : 512,
          channels: 4
        }
      })
      if (z > 2) {
        image = image.extract({
          left: 256, top: 256, width: 512, height: 512
        })
      }
      cb(null, image)
    })
  })
}, { concurrent: 6 })

app.get(`/zxy/:z/:x/:y.pbf`, async (req, res) => {
  const z = parseInt(req.params.z)
  const x = parseInt(req.params.x)
  const y = parseInt(req.params.y)
  getConcatenatedTile(z, x, y).then(tile => {
    res.set('content-type', 'application/vnd.mapbox-vector-tile')
    res.set('content-encoding', 'gzip')
    res.send(tile)
  }).catch(e => {
    res.status(404).send(`tile not found /zxy/${z}/${x}/${y}.pbf: ${e}`)
  })
})

app.get('/zxy/:z/:x/:y.png', (req, res) => {
  tileQueue.push({
    z: parseInt(req.params.z),
    x: parseInt(req.params.x),
    y: parseInt(req.params.y)
  }, (err, image) => {
    if (err) {
      res.send(err)
    } else {
      res.set('content-type', 'image/png')
      image.png().toBuffer()
        .then((result) => {
          res.send(result)
        })
    }
  })
})

spdy.createServer({
  cert: cert,
  key: key
}, app).listen(port)
