import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const ajvDistPath = path.join(rootDir, 'node_modules', 'ajv', 'dist');

function patchFile(filePath, search, replace) {
    const fullPath = path.join(ajvDistPath, filePath);
    if (!fs.existsSync(fullPath)) {
        console.warn(`File not found: ${fullPath}`);
        return;
    }

    let content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes(replace)) {
        console.log(`Already patched: ${filePath}`);
        return;
    }

    if (content.includes(search)) {
        content = content.replace(search, replace);
        fs.writeFileSync(fullPath, content);
        console.log(`Patched: ${filePath}`);
    } else {
        console.warn(`Search string not found in: ${filePath}`);
    }
}

// Read JSON contents
const dataJsonPath = path.join(ajvDistPath, 'refs', 'data.json');
const draft7JsonPath = path.join(ajvDistPath, 'refs', 'json-schema-draft-07.json');

let dataJsonContent = '{}';
let draft7JsonContent = '{}';

try {
    dataJsonContent = fs.readFileSync(dataJsonPath, 'utf8').trim();
    draft7JsonContent = fs.readFileSync(draft7JsonPath, 'utf8').trim();
} catch (e) {
    console.error("Failed to read JSON reference files", e);
}

// Patch core.js
patchFile('core.js', 'const $dataRefSchema = require("./refs/data.json");', `const $dataRefSchema = ${dataJsonContent};`);

// Patch ajv.js
patchFile('ajv.js', 'const draft7MetaSchema = require("./refs/json-schema-draft-07.json");', `const draft7MetaSchema = ${draft7JsonContent};`);
