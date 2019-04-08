const config = require('config')
const fs = require('fs')
const express = require('express')
const spdy = require('spdy')
const cors = require('cors')
const MBTiles = require('@mapbox/mbtiles')
const mbgl = require('@mapbox/mapbox-gl-native')
const mapnik = require('mapnik')

const farms = require(config.get('farmsPath'))
const cert = fs.readFileSync(config.get('certPath'))
const key = fs.readFileSync(config.get('keyPath'))
const port = config.get('port')
const htdocsPath = config.get('htdocsPath')

let mbtilesPool = {}

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

spdy.createServer({
  cert: cert,
  key: key
}, app).listen(port)
