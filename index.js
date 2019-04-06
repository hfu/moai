const config = require('config')
const fs = require('fs')
const express = require('express')
const spdy = require('spdy')
const cors = require('cors')
const MBTiles = require('@mapbox/mbtiles')
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
    console.log(JSON.stringify(mbtilesPool))
    for (let key in farms) {
      const mbtilesPath = farms[key].getMbtilesPath(z, x, y)
      let mbtiles = mbtilesPool[mbtilesPath]
      if (!mbtiles) {
        console.log(`newly opening ${mbtilesPath} for ${z}/${x}/${y}`)
        try {
          mbtiles = mbtilesPool[mbtilesPath] = openMbtiles(mbtilesPath)
        } catch (e) {
          continue
        }
      }
      try {
        console.log(`${z}/${x}/${y} from ${mbtilesPath}`)
        let t = new mapnik.VectorTile(z, x, y)
        t.addDataSync(
          await getEachTile(await mbtiles, z, x, y),
          { validate: true })
        contents.push(t)
        keys.push(key)
      } catch (e) {
        // console.error(e)
        continue
      }
    }
    let vectorTile = new mapnik.VectorTile(z, x, y)
    try {
      vectorTile.compositeSync(contents)
    console.log(`merging ${contents.length}`)
    console.log(contents.map(v => v.length))
    console.log(keys)
    console.log(vectorTile)
    console.log(vectorTile.toGeoJSONSync('__all__'))
    } catch (e) {
      console.log(e)
    }
    if (keys.length > 0) {
      console.log(`after concat ${keys.length}`)
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
