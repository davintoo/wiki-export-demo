const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const CBT_HOST = process.env.CBT_HOST || '';
const API_TOKEN = process.env.API_TOKEN || '';
const BASE_PATH = process.env.OUTPUT_DIR || `${__dirname}/out`;

if(!CBT_HOST) {
    console.log('set env variable CBT_HOST');
    process.exit(1);
}

if(!API_TOKEN) {
    console.log('set env variable API_TOKEN');
    process.exit(1);
}

const httpsAgent = new https.Agent({
    keepAlive: true
});


class WikiPage {
    constructor(title, json, links = []) {
        this.title = title;
        this.files = (json.files || []).map(f => {
            return {
                url: f.url,
                name: f.name
            }
        });
        this.links = links;
        this.children = {};
    }
}

const downloadFile = async (url, path) => {
    try {
        const response = await fetch(url, {
            agent: httpsAgent,
            headers: {
                'X-Cbr-Authorization': `Bearer ${API_TOKEN}`,
            }
        });
        const buffer = await response.buffer();
        fs.writeFileSync(path, buffer);
    } catch (err) {
        console.error(url, err);
    }
}

function sanitizeFilename(filename) {
    return filename.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_');
}


async function buildWikiTree(startTitle, visitedPages = new Set()) {
    if (visitedPages.has(startTitle)) {
        return null;
    }

    visitedPages.add(startTitle);
    // console.log(`Page: ${startTitle}`);

    try {
        const response = await fetch(`${CBT_HOST}/api/v2/wiki/get-item/${encodeURIComponent(startTitle)}`, {
            headers: {
                'X-Cbr-Authorization': `Bearer ${API_TOKEN}`
            },
            agent: httpsAgent
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const res = await response.json();
        // console.log('res', res.data.html);

        const $ = cheerio.load(res.data.html);
        const page = new WikiPage(startTitle, res.data);

        const links = [];
        $('a').each((index, element) => {
            const href = $(element).attr('href');
            if (href && href.startsWith('wiki/')) {
                const linkTitle = href.substring('wiki/'.length);
                links.push(linkTitle);
            }
            if (href && href.startsWith(`${CBT_HOST}/wiki/`)) {
                const linkTitle = href.substring(`${CBT_HOST}/wiki/`.length);
                links.push(linkTitle);
            }
        });

        page.links = links;
        for (const linkTitle of links) {
            const childPage = await buildWikiTree(linkTitle, visitedPages);
            if (childPage) {
                page.children[linkTitle] = childPage;
            }
        }

        return page;
    } catch (error) {
        console.error(`Помилка при обробці сторінки ${startTitle}:`, error.message);
        return null;
    }
}

async function crawlWiki(startTitle) {
    try {
        console.log(`Start crawl wiki: ${startTitle}`);
        const wikiTree = await buildWikiTree(startTitle);
        console.log('Обхід Wiki завершено');
        return wikiTree;
    } catch (error) {
        console.error('Error crawl wiki:', error);
        throw error;
    }
}


async function syncTree(wikiTree) {
    try {
        if (!fs.existsSync(BASE_PATH)) {
            fs.mkdirSync(BASE_PATH, {recursive: true});
        }

        async function processNode(node, currentPath) {
            if (!node) return;
            //console.log('processNode', node.title);

            const safeName = sanitizeFilename(node.title);
            const nodePath = path.join(currentPath, safeName);

            if (!fs.existsSync(nodePath)) {
                fs.mkdirSync(nodePath, {recursive: true});
                console.log(`Створено папку: ${nodePath}`);
            }

            for (const file of node.files) {
                await downloadFile(CBT_HOST + file.url, path.join(nodePath, file.name));
            }

            for (const [childTitle, childNode] of Object.entries(node.children)) {
                await processNode(childNode, nodePath);
            }
        }

        await processNode(wikiTree, BASE_PATH);
    } catch (error) {
        console.error('Error syncTree:', error);
        throw error;
    }
}


(async () => {
    try {
        const wikiTree = await crawlWiki('Home');
        //console.log('wikiTree', wikiTree);
        await syncTree(wikiTree);
        console.log('Done');
    } catch (err) {
        console.error(err);
    }
})();
