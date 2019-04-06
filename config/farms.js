const config = require('config')
const a320Path = config.get('a320Path')
const cs100Path = config.get('cs100Path')

module.exports = {
  a320: { 
    getMbtilesPath: (z, x, y) => {
      if (z < 6) {
        return `${a320Path}/0-0-0.mbtiles`
      } else {
        return `${a320Path}/6-${x >> (z - 6)}-${y >> (z - 6)}.mbtiles`
      }
    }
  },
  lc: {
    getMbtilesPath: (z, x, y) => {
      return `${cs100Path}/lc.mbtiles`
    }
  },
  hs: {
    getMbtilesPath: (z, x, y) => {
      return `${cs100Path}/hs.mbtiles`
    }
  },
  ocean: {
    getMbtilesPath: (z, x, y) => {
      return `${cs100Path}/ocean.mbtiles`
    }
  },
  others: {
    getMbtilesPath: (z, x, y) => {
      return `${cs100Path}/others.mbtiles`
    }
  }
}
