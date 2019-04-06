import test from 'ava'
const config = require('config')
const farms = require(config.get('farmsPath'))
const a320Path = config.get('a320Path')
const cs100Path = config.get('cs100Path')

test('test the content of farm.js', t => {
  t.is(farms.a320.getMbtilesPath(0, 0, 0), `${a320Path}/0-0-0.mbtiles`)
  t.is(farms.hs.getMbtilesPath(6, 37, 32), `${cs100Path}/hs.mbtiles`)
  t.pass()
})
