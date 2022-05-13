const fetch = require('node-fetch');
const striptags = require('striptags');
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const sharp = require('sharp');
const Entities = require('html-entities').AllHtmlEntities;
const entities = new Entities();
const dayjs = require('dayjs');
const fileSignature = dayjs().format("YYYY-MM-DD-HH-mm-ss");
// const tmpdir = require('os').tmpdir;
const CACHE_PATH = __dirname + '/cache';
const LOCAL_ICONS_PATH = __dirname + '/../local_icons';
const LOCAL_ICONS_SX = 220;
const LOCAL_ICONS_SY = 132;
const NTVP_DOMAIN = 'https://ntvplus.ru';
const NTVP_URL = '/faq/nastrojka-kanalov-54';
const MAX_REQUEST_URL_PAUSE = 10000;
const write = util.promisify(fs.write);
const PICONS_PATH = 'picons';
const RESULT_TABLE_HTML_FILE = `ntvp-channels-list.${fileSignature}.html`;
const DREAMBOX_LAMEDB_FILE = './dreamBox/lamedb';
const DREAMBOX_LAMEDB_GENERATED_FILE = `lamedb.${fileSignature}`;

let ntvChannels = [];
let ntvAligned = [];
let transponders = [];
let services = [];


const rusToLatin = (function () {
  const in__chrs = 'абвгдеёзийклмнопрстуфхыэю';
  const out_chrs = 'abvgdeeziiklmnoprstufhieu';
  const transl = {'ж': 'zh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'я': 'ya'};
  const chars_rgx = new RegExp('[' + in__chrs + _.keys(transl)
                                                 .join('') + ']', 'g');
  const lookup = function (m) {
    return transl[m] || m;
  };

  for (let i = 0; i < in__chrs.length; i++) {
    transl[in__chrs[i]] = out_chrs[i];
  }

  return function (s) {
    return s.replace(chars_rgx, lookup);
  }
})();

const processName = name => name.toLowerCase()
                                .replace(/[^\w\dйцукенгшщзхъфывапролджэячсмитьбю]/g, '');

function urlToFilename(_url) {
  const url = _url.substr(0, NTVP_DOMAIN.length) === NTVP_DOMAIN ? _url.substr(NTVP_DOMAIN.length) : _url;

  return url.replace(/[^.\w]+/g, '_');
}

function getUrl(url, fileType = 'utf-8') {
  const cacheFileName = CACHE_PATH + '/' + urlToFilename(url);

  return new Promise((resolve, reject) => {
    util.promisify(fs.readFile)(cacheFileName, fileType)
        .then(resolve)
        .catch(() => {
          setTimeout(() => {  // я растягиваю запросы на случайное врем в пределах (см. константу)
//          console.log('Loading from URL ' + url);
            fetch(url)
              .then(res => {
                if (!res.ok) {
                  throw new Error(`Response with ${res.status} from ${url}`);
                }
                fs.mkdir(CACHE_PATH, {recursive: true}, () => {
                });
                const dest = fs.createWriteStream(cacheFileName);
                res.body.pipe(dest);
                return res.text();
              })
              .then(resolve)

              .catch(reject);
          }, Math.random() * MAX_REQUEST_URL_PAUSE)
        });
  });
}

function getChannelTable() {
  console.log('## Get channels table');
  return getUrl(NTVP_DOMAIN + NTVP_URL);
}

async function parseChannelIcon(channel) {
  const infoHtml = await getUrl(NTVP_DOMAIN + channel.infoUrl);
  const iconUrl = infoHtml.match(/og:image.*?content="(.*?)"/);
  const descr = infoHtml.match(/<\/h1.*?richtext\s+channel--text">(.*?)<\/div/s);

  if (iconUrl && iconUrl[1]) {
    channel.icon = iconUrl[1];
  }

  if (descr && descr[1]) {
    channel.description = entities.decode(striptags(descr[1]));
  }

  if (channel.icon) {
    await getUrl(channel.icon);

    channel.local_icon = await copyLocalIcon(channel.icon, createIconName(channel));
  }

  return channel;
}

function copyLocalIcon(url, fileName) {
  const localName = fileName + '.png';

  return new Promise((resolve, reject) =>
    getUrl(url, null).then(
      buffer => {
        (new Promise(function (resolve) {
          sharp(buffer)
            .extractChannel('alpha')
            .toBuffer((err, data, info) => {
              if (err) {
                resolve(info)
              } else
                sharp(data)
                  .trim(3)
                  .toBuffer((err, fg, info) => {
                    resolve(info)
                  })
            })
        }))
          .then(info => {
            let sha = sharp(buffer);

            if (info) {
              sha = sha.extract({
                left: -info.trimOffsetLeft,
                top: -info.trimOffsetTop,
                width: info.width,
                height: info.height,
              })
            } else {
              sha = sha.trim(1);
            }
            sha.resize(LOCAL_ICONS_SX, LOCAL_ICONS_SY, {fit: 'contain', background: {r: 0, g: 0, b: 0, alpha: 0}})
               .toFile(LOCAL_ICONS_PATH + '/' + localName, (err, info) => {
                 if (err) {
                   reject(err)
                 } else resolve(localName)
               })
          })
      })
  )
}

function createIconName(channel) {
  return rusToLatin(channel.name.toLowerCase())
    .replace(/[^\w]/g, '');
}

function parseTableLine(lineArr) {
  const transponder = parseInt(striptags(lineArr[1]));
  const sat = parseInt(striptags(lineArr[4]));

  const [skip, freq, modulation, sr] = lineArr[3].match(
    /Частота вещания[^>]+<\/b>(.*?)<.*?Модуляция:[^>]+>(.*?)<.*?Символьная.*?(\d+)/s
  );

  return _.map([...lineArr[2].matchAll(/<a\s+href=['"](.*?)["'][^>]{0,}>(.*?)<\/a>/sg)], channel => {
    return {
      name: channel[2],
      infoUrl: channel[1],
      freq: freq.split(' ')[0],
      transponder,
      sat,
      modulation,
      sr: parseInt(sr)
    }
  });
}

function parseChannelsTable(html) {
  console.log('## Parse channels table');
  const text = html.match(/<h4>Параметры настройки<\/h4>.*?<table>(.*?)<\/table>/s);
  if (!text || !text[1] || !text[1].length) {
    throw new Error('Таблица настройки не найдена в коде ' + NTVP_URL);
  }

  const lines = [...text[1].matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/sg)];

  return _.flatten(_.map(lines, parseTableLine));
}

function scanChannelsInfo(table) {
  console.log('## Scan channels info');
  fs.mkdir(LOCAL_ICONS_PATH, {recursive: true}, () => {
  });

  return Promise.all(table.map(channel => parseChannelIcon(channel)))
}

function outputTable(table) {
  console.log('## Output table: ', table.length, 'channels are listed');

  let text = '<table><tbody>';
  text += '<tr><th>' + _.keys(table[0]).join('</th><th>') + '</th></tr>';
  text += table.map(ch => '<tr><td>' + _.values(ch).join('</td><td>') + '</td></tr>').join('');
  text += '</tbody></table>';

  return util.promisify(fs.open)(RESULT_TABLE_HTML_FILE, 'w')
             .then(fd =>
               write(fd, text).then(() => util.promisify(fs.close)(fd))
             )
             .catch(err => console.error('Table write error', err))
}

function scanNtv() {
  console.log('## Scan NTV');
  return getChannelTable()
    .then(parseChannelsTable)
    //            .then(list=>list.slice(0,5))
    //  .then(list=>_.filter(list, item=>createIconName(item)==='kinouzhas'))
    .then(scanChannelsInfo)
    .then(table => {
      ntvChannels = table;
      return table;
    })
    .then(outputTable)
    .catch(err => console.error('SCAN ERROR: ', err))
}

function getTransponders(text) {
  const section = text.match(/\ntransponders(.*?)\nend/s);
  if (!section || !section[1] || !section[1].length) {
    throw new Error('Секция транспондеров не найдена в lamedb');
  }
  const items = section[1].split('/');

  items.pop();

  console.log('Transponders found:', items.length);

  return _.map(items, item => {
    const t = item.match(/\s+(\w+):(\w+):(\w+)\n\s+s\s+(\d+):(\d+):(\d):(\d{1,2}):(\d+):(\d):(\d):?(\d)?:?(\d)?:?(\d)?:?(\d)?/s);

    return {
      text: item,
      namespace: t[1],
      streamId: t[2],
      networkId: t[3],
      freq: t[4],
      bitrate: t[5],
      polarization: t[6], // 0=Horizontal, 1=Vertical, 2=Circular Left, 3=Circular right.
      fec: t[7], //Forward Error Control (FEC): 0=None , 1=Auto, 2=1/2, 3=2/3, 4=3/4 5=5/6, 6=7/8, 7=3/5, 8=4/5, 9=8/9, 10=9/10.
      orbit: t[8],//Orbital Position: in degrees East: 130 is 13.0E, 192 is 19.2E. Negative values are West -123 is 12.3West.
      inversion: t[9], // 0=Auto, 1=On, 2=Off
      flags: t[10],//Flags (Only in version 4): Field is absent in version 3.
      system: t[11],//System: 0=DVB-S 1=DVB-S2.
      modulation: t[12],//: 0=Auto, 1=QPSK, 2=QAM16, 3=8PSK.
      rolloff: t[13],// (Only used in DVB-S2): 0=0.35, 1=0.25, 3=0.20
      pilot: t[14],// (Only used in DVB-S2): 0=Auto, 1=Off, 1=On.
    }
  });
}

function getServices(text) {
  const res = [];
  const section = text.match(/\nservices\s+(.*?)\nend/s);
  if (!section || !section[1] || !section[1].length) {
    throw new Error('Секция сервисов не найдена в lamedb');
  }
  const items = section[1].split('\n');

  console.log('Services found', items.length / 3);

//  0795:01680000:0013:0070:2:0
//  Юмор FM
//  p:HTB+,f:40
  while (items.length > 2) {
    const l1 = items.shift();
    const name = items.shift();
    const providerData = items.shift();

    const t = l1.match(/(\w+):(\w+):(\w+):(\w+):(\d+):(\d+)/);

    res.push({
      name,
      serviceId: t[1],
      namespace: t[2],
      streamId: t[3],
      networkId: t[4],
      type: t[5],
      serviceNum: t[6],
      providerData
    });
  }

  return res;
}

function transponderToLameString(t) {
  return [t.namespace, t.streamId, t.networkId].join(':') + '\n\ts ' +
    _.compact([
      t.freq,
      t.bitrate,
      t.polarization,
      t.fec,
      t.orbit,
      t.inversion,
      t.flags,
      t.system,
      t.modulation,
      t.rolloff,
      t.pilot,
    ])
     .join(':') + '\n/\n';
}

function serviceToLameString(s) {
  return [s.serviceId, s.namespace, s.streamId, s.networkId, s.type, s.serviceNum].join(':') + '\n' +
    s.name + '\n' + s.providerData + '\n';
}

function createLameDb(trans, serv) {
  console.log('## Create Lame DB');
  return util.promisify(fs.open)(DREAMBOX_LAMEDB_GENERATED_FILE, 'w')
             .then(fd => {
               return write(fd, 'eDVB services /4/\ntransponders\n')
                 .then(write(fd, _.map(trans, item => transponderToLameString(item))
                                  .join('')))
                 .then(write(fd, 'end\nservices\n'))
                 .then(write(fd, _.map(serv, item => serviceToLameString(item))
                                  .join('')))
                 // .then(()=>{
                 //   console.log('***** dbg12')
                 // })
                 .then(write(fd, 'end\nEdited with manEdit'))
                 // .then(()=>{
                 //   console.log('***** dbg13')
                 // })
                 .then(util.promisify(fs.close)(fd))
                 // .then(()=>{
                 //   console.log('***** dbg14')
                 // })
             })
             .catch(e => {
               console.error(e.message || e);
             });
}

function alignServices() {
  let orphans = [];

  console.log('## Align services');
  _.each(services, service => {
    const ntv = _.find(ntvChannels, item => processName(item.name) === processName(service.name));

    if (ntv) {
//       const index = _.indexOf(ntvChannels, ntv);
      ntvAligned.push(ntv);
//       ntvChannels.splice(index,1);
      service.ntv = ntv;
    } else {
      orphans.push(service.name);

      //_.each(ntvChannels, item=>console.log('--CMP: '+processName(item.name)+'==='+processName(service.name)));
    }
  });

  console.log('Aligned channels:', ntvAligned.length);
  console.log('Services w/o NTV channel:', orphans.length, orphans.join(', '));

//  console.log('--Aligned: ', ntvAligned.map(item=>item.name).join(', '));
//  console.log('--Orphans: ', orphans.join('; '));
}

const toHex = x => parseInt(x).toString(16);

const cutZero = x => {
  let i = 0;
  while (i < x.length - 1 && x[i] === '0') {
    i++
  }
  return x.substring(i)
          .toUpperCase();
};

function generatePiconName(service) {
  //1_0_19_580_E_70_1680000_0_0_0.png
  return [
    1, 0,
    toHex(service.type),
    cutZero(service.serviceId),
    cutZero(service.streamId),
    cutZero(service.networkId),
    cutZero(service.namespace),
    0, 0, 0

  ].join('_') + '.png';
}

function updateAttribute(service, attr) {
  if (service[attr] !== service.ntv[attr]) {
    service[attr] = service.ntv[attr];
  }
}

function updateServices() {
  console.log('## Update services');
  _.each(services, service => {
    if (service.ntv) {
      _.each(['name',], attr => updateAttribute(service, attr))
    }
  });
}

function copyPicons() {
  console.log(`## Copy picons (target path is ${PICONS_PATH}/`);
  fs.mkdir(PICONS_PATH, {recursive: true}, () => {
  });

  _.each(services, service => {
    if (service.ntv) {
      const picName = generatePiconName(service);

      fs.copyFile(CACHE_PATH + '/' + urlToFilename(service.ntv.icon), PICONS_PATH + '/' + picName, (a, b) => {
        // console.log(a,b);
      });
      //console.log(service.name, ' ==> ', picName);
    }
  });
}

function scanLameDb() {
  console.log('## Scan Lame DB');
  return util.promisify(fs.readFile)(DREAMBOX_LAMEDB_FILE, 'utf-8')
             .then(text => {
               transponders = getTransponders(text);
               services = getServices(text);

               alignServices();
               updateServices();
               copyPicons();
               return createLameDb(transponders, services);
             })
             .catch(err => console.error('Read file error', err))
}

scanNtv()
  .then(scanLameDb)
  .then(()=>{
    console.log(`#### All DONE. Files signature is [${fileSignature}]`)
  })
  .catch(error => console.error('Global throws:', error));
