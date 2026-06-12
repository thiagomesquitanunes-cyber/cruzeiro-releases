const extract = require('extract-zip'); 
const fs = require('fs'); 
const path = require('path'); 
console.log('starting extraction...'); 
const zipPath = path.join(process.env.LOCALAPPDATA, 'electron', 'Cache', '9bba7013435de7753e6ceff232a49ca080ff8fc26705ad97ed62e68579c487f5', 'electron-v36.9.5-win32-x64.zip'); 
console.log('zip exists:', fs.existsSync(zipPath)); 
const distDir = path.join(__dirname, 'node_modules', 'electron', 'dist'); 
extract(zipPath, { dir: distDir }).then(function() { console.log('extracted OK'); fs.writeFileSync(path.join(__dirname,'node_modules','electron','path.txt'), 'electron.exe'); console.log('path.txt written'); }).catch(function(e) { console.error('EXTRACT ERROR:', e); }); 
