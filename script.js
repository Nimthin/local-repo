const puppeteer = require('puppeteer');
const XLSX = require('xlsx');
const fs = require('fs-extra');

const TWITTER_USERNAME = 'hehehehemz17680';
const TWITTER_PASSWORD = 'Qwerty@123';
const MAX_TWEETS = 500;
const PROFILE_URL = 'https://x.com/AmericanExpress/with_replies';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loginToTwitter(page) {
  await page.goto('https://x.com/login', { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[name="text"]');
  await page.type('input[name="text"]', TWITTER_USERNAME);
  await page.keyboard.press('Enter');
  await wait(2000);

  try {
    await page.waitForSelector('input[name="text"]', { timeout: 5000 });
    await page.type('input[name="text"]', TWITTER_USERNAME);
    await page.keyboard.press('Enter');
  } catch {}

  await page.waitForSelector('input[name="password"]');
  await page.type('input[name="password"]', TWITTER_PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
}

async function scrapeUserMetadata(browser, username) {
  const profileUrl = `https://x.com/${username}`;
  const page = await browser.newPage();
  try {
    await page.goto(profileUrl, { waitUntil: 'networkidle2' });
    await wait(3000);

    return await page.evaluate(() => {
      const getText = selector =>
        document.querySelector(selector)?.innerText?.trim() || '';

      const fullName = getText('div[data-testid="UserName"] span');
      const bio = getText('div[data-testid="UserDescription"]');
      const location = getText('div[data-testid="UserProfileHeader_Items"] > span:nth-child(1)');

      // Joined date
      const joinedRaw = Array.from(document.querySelectorAll('span'))
        .map(el => el.innerText)
        .find(t => t.includes('Joined')) || '';

      let joined = '';
      const match = joinedRaw.match(/Joined (\w+)\s+(\d{4})/i);
      if (match) {
        const monthMap = {
          January: '01', February: '02', March: '03', April: '04',
          May: '05', June: '06', July: '07', August: '08',
          September: '09', October: '10', November: '11', December: '12'
        };
        joined = `${monthMap[match[1]]}/${match[2]}`;
      }

      const birthdate = Array.from(document.querySelectorAll('span'))
        .map(el => el.innerText)
        .find(t => t.toLowerCase().includes('born')) || '';

      const website = Array.from(document.querySelectorAll('a[role="link"]'))
        .map(a => a.href)
        .find(href => !href.includes('x.com'));

      const jsonLdTag = document.querySelector('script[type="application/ld+json"]');
      let followers = '', following = '', tweets = '', imageUrl = '', createdAt = '';

      if (jsonLdTag) {
        try {
          const json = JSON.parse(jsonLdTag.innerText);
          const entity = json.mainEntity || {};
          const stats = entity.interactionStatistic || [];

          for (const stat of stats) {
            if (stat.name === 'Follows') followers = stat.userInteractionCount.toString();
            else if (stat.name === 'Friends') following = stat.userInteractionCount.toString();
            else if (stat.name === 'Tweets') tweets = stat.userInteractionCount.toString();
          }

          imageUrl = entity.image?.contentUrl || '';
          createdAt = json.dateCreated || '';
        } catch (e) {
          console.warn('⚠️ Failed to parse JSON-LD:', e.message);
        }
      }

      // Verified check
      const verified = !!document.querySelector('svg[aria-label="Verified account"]');

      return {
        fullName,
        bio,
        location,
        birthdate,
        joined,
        followers,
        following,
        tweetCount: tweets,
        profileImageUrl: imageUrl,
        website: website || '',
        accountCreationDate: createdAt,
        verified,
        profileUrl: window.location.href,
        professionalCategory: ''
      };
    });
  } catch (err) {
    console.warn(`❌ Failed to scrape metadata for ${username}:`, err.message);
    return {
      fullName: '',
      bio: '',
      location: '',
      joined: '',
      followers: '',
      following: '',
      tweetCount: '',
      profileImageUrl: '',
      professionalCategory: '',
      website: '',
      birthdate: '',
      accountCreationDate: '',
      verified: '',
      profileUrl
    };
  } finally {
    await page.close();
  }
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--start-maximized'],
    defaultViewport: null
  });

  const page = await browser.newPage();
  await loginToTwitter(page);
  await page.goto(PROFILE_URL, { waitUntil: 'networkidle2' });

  const tweets = new Set();
  const results = [];
  const cachedAuthors = new Map();

  while (results.length < MAX_TWEETS) {
    const newTweets = await page.evaluate(() => {
      const items = [];
      const nodes = document.querySelectorAll('article');

      for (const node of nodes) {
        try {
          const urlElem = node.querySelector('a[href*="/status/"]');
          const url = urlElem?.href || '';
          const timestamp = urlElem?.querySelector('time')?.getAttribute('datetime') || '';
          const text = node.querySelector('[data-testid="tweetText"]')?.innerText || '';
          const stats = node.querySelectorAll('[data-testid="app-text-transition-container"]');
          const replies = stats[0]?.innerText || '0';
          const retweets = stats[1]?.innerText || '0';
          const likes = stats[2]?.innerText || '0';
          const views = stats[3]?.innerText || '0';

          const authorAnchor = node.querySelector('a[href^="/"][role="link"]');
          const authorUsername = authorAnchor ? authorAnchor.getAttribute('href').split('/')[1] : '';

          items.push({ text, url, timestamp, replies, retweets, likes, views, authorUsername });
        } catch (e) {
          console.error('Error parsing tweet:', e);
        }
      }

      return items;
    });

    for (const t of newTweets) {
      if (!t.url || tweets.has(t.url) || t.authorUsername.toLowerCase() === 'americanexpress') continue;
      tweets.add(t.url);

      // Get user metadata from cache or scrape
      let authorMeta = cachedAuthors.get(t.authorUsername);
      if (!authorMeta) {
        authorMeta = await scrapeUserMetadata(browser, t.authorUsername);
        cachedAuthors.set(t.authorUsername, authorMeta);
      }

      const rowData = {
        Date: t.timestamp,
        Text: t.text.replace(/\n/g, ' ').trim(),
        Replies: t.replies,
        Retweets: t.retweets,
        Likes: t.likes,
        Views: t.views,
        URL: t.url,
        AuthorUsername: t.authorUsername,
        ...authorMeta
      };

      results.push(rowData);

      // Log everything in console
      console.log(`[${results.length}]`, rowData);

      if (results.length >= MAX_TWEETS) break;
    }

    if (results.length < MAX_TWEETS) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await wait(2500);
    }
  }

  // Save to Excel
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `tweets_with_user_meta_${timestamp}.xlsx`;

  const ws = XLSX.utils.json_to_sheet(results);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tweets');
  XLSX.writeFile(wb, filename);

  console.log(`✅ Saved ${results.length} tweets with metadata to ${filename}`);
  await browser.close();
})();
