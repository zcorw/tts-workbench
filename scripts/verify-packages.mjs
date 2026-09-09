import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve('apps/api');
const pkg=JSON.parse(readFileSync(resolve(root,'package.json')));
const lock=JSON.parse(readFileSync(resolve(root,'package-lock.json')));
for(const [name,path] of Object.entries(pkg.dependencies))if(path.startsWith('file:')){
 const actual='sha512-'+createHash('sha512').update(readFileSync(resolve(root,path.slice(5)))).digest('base64');
 assert.equal(lock.packages[`node_modules/${name}`].integrity,actual,`${name}: lock must match versioned artifact`);
}
console.log('Versioned package artifacts match API lock integrity');
