const Apify = require('apify');
const { scrapePosts, handlePostsGraphQLResponse } = require('./posts');
const { scrapeComments, handleCommentsGraphQLResponse }  = require('./comments');
const { scrapeDetails }  = require('./details');
const { searchUrls } = require('./search');
const { login } = require('./login');
const { getItemSpec } = require('./helpers');
const { GRAPHQL_ENDPOINT, ABORTED_RESOUCE_TYPES, SCRAPE_TYPES } = require('./consts');
const errors = require('./errors');

async function main() {
    const input = await Apify.getInput();
    const { proxy, resultsType, resultsLimit = 200 } = input;

    if (proxy.apifyProxyGroups && proxy.apifyProxyGroups.length === 0) delete proxy.apifyProxyGroups;

    let maxConcurrency = 1000;

    const usingLogin = (input.loginCookies && Array.isArray(input.loginCookies)) || (input.loginUsername && input.loginPassword);

    if (usingLogin) {
        await Apify.utils.log.warning('Either login credentials or cookies were used, setting maxConcurrency to 1 and using one proxy session!');
        maxConcurrency = 1;
        if (proxy.useApifyProxy) proxy.apifyProxySession = `insta_session_${Date.now()}`;
    }


    const foundUrls = await searchUrls(input);
    const urls = [
        ...(input.directUrls || []), 
        ...foundUrls,
    ];

    if (urls.length === 0) {
        Apify.utils.log.info('No URLs to process');
        process.exit(0);
    }

    await searchUrls(input);

    try {
        if (!proxy) throw errors.proxyIsRequired();
        if (!resultsType) throw errors.typeIsRequired();
        if (!Object.values(SCRAPE_TYPES).includes(resultsType)) throw errors.unsupportedType(resultsType);
    } catch (error) {
        console.log('--  --  --  --  --');
        console.log(' ');
        Apify.utils.log.error(`Run failed because the provided input is incorrect:`);
        Apify.utils.log.error(error.message);
        console.log(' ');
        console.log('--  --  --  --  --');
        process.exit(1);
    }

    const requestListSources = urls.map((url) => ({
        url,
        userData: { limit: resultsLimit },
    }));

    const requestList = await Apify.openRequestList('request-list', requestListSources);

    const gotoFunction = async ({ request, page }) => {
        await page.setBypassCSP(true);
        if (input.loginCookies && Array.isArray(input.loginCookies)) {
            await page.setCookie(...input.loginCookies);
        } else if (input.loginUsername && input.loginPassword) await login(input.loginUsername, input.loginPassword, page);

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (ABORTED_RESOUCE_TYPES.includes(request.resourceType())) return request.abort();
            request.continue();
        });

        page.on('response', async (response) => {
            const responseUrl = response.url();

            // Skip non graphql responses
            if (!responseUrl.startsWith(GRAPHQL_ENDPOINT)) return;

            // Wait for the page to parse it's data
            while (!page.itemSpec) await page.waitFor(100);

            switch (resultsType) {
                case SCRAPE_TYPES.COMMENTS: return handleCommentsGraphQLResponse(page, response)
                    .catch( error => Apify.utils.log.error(error));
            }
        });

        const response = await page.goto(request.url, {
            // itemSpec timeouts
            timeout: 50 * 1000,
        });

        if (input.loginCookies && Array.isArray(input.loginCookies)) {
            try {
                await page.waitForSelector('span[aria-label="Profile"]', { timeout: 10000 });
            } catch (loginError) {
                await Apify.utils.log.info('Failed to log in using cookies, they are probably no longer usable and you need to set new ones.');
                process.exit(1);
            }
        }

        return response;
    };

    const handlePageFunction = async ({ page, request }) => {
        const entryData = await page.evaluate(() => window.__initialData.data.entry_data);
        if (entryData.LoginAndSignupPage) {
            await Apify.utils.log.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
            await Apify.utils.log.error(`Cannot load data from page ${request.url}`);
            await Apify.utils.log.error(`This page requires login`);
            await Apify.utils.log.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
            return [];
        }
        const itemSpec = getItemSpec(entryData);
        page.itemSpec = itemSpec;

        switch (resultsType) {
            case SCRAPE_TYPES.POSTS: return scrapePosts(page, request, itemSpec, entryData, input, proxy);
            case SCRAPE_TYPES.COMMENTS: return scrapeComments(page, request, itemSpec, entryData);
            case SCRAPE_TYPES.DETAILS: return scrapeDetails(input, request, itemSpec, entryData, page);
        };
    }

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        gotoFunction,
        puppeteerPoolOptions: {
            maxOpenPagesPerInstance: 1
        },
        launchPuppeteerOptions: {
            ...proxy,
        },
        maxConcurrency,
        handlePageTimeoutSecs: 12 * 60 * 60,
        handlePageFunction,

        // If request failed 4 times then this function is executed.
        handleFailedRequestFunction: async ({ request }) => {
            Apify.utils.log.error(`${request.url}: Request ${request.url} failed 4 times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
                '#error': request.url
            });
        },
    });

    await crawler.run();
};

module.exports = main;