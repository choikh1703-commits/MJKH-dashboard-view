import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const passphrase = process.env.PORTFOLIO_DASHBOARD_PASSPHRASE;
const rawCodes = process.env.PORTFOLIO_PRICE_CODES;
const rawBook = process.env.PORTFOLIO_LIVE_BOOK;
const force = process.env.FORCE_UPDATE === '1';

if (!passphrase || passphrase.length < 12) {
  throw new Error('PORTFOLIO_DASHBOARD_PASSPHRASE must contain at least 12 characters.');
}
if (!rawCodes) throw new Error('PORTFOLIO_PRICE_CODES is required.');

const parsedCodes = JSON.parse(rawCodes);
const codes = [...new Set(parsedCodes.map((code) => String(code).padStart(6, '0')))].filter((code) => /^\d{6}$/.test(code));
if (!codes.length || codes.length !== parsedCodes.length) throw new Error('PORTFOLIO_PRICE_CODES contains an invalid code.');
const book = rawBook ? JSON.parse(rawBook) : null;
if (book) {
  if (!Array.isArray(book.holdings) || !Number.isFinite(Number(book.cash)) || !Number.isFinite(Number(book.cashIncome))) {
    throw new Error('PORTFOLIO_LIVE_BOOK is invalid.');
  }
  for (const holding of book.holdings) {
    if (!/^\d{6}$/.test(String(holding.code)) || !Number.isFinite(Number(holding.quantity)) || !Number.isFinite(Number(holding.costBasis))) {
      throw new Error('PORTFOLIO_LIVE_BOOK contains an invalid holding.');
    }
  }
}

const now = new Date();
const kst = kstParts(now);
const inRegularSession = kst.weekday >= 1 && kst.weekday <= 5
  && kst.minutes >= 9 * 60
  && kst.minutes <= 15 * 60 + 30;

if (!force && !inRegularSession) {
  console.log(JSON.stringify({ status: 'skipped', reason: 'outside_krx_regular_session', kst: kst.label }));
  process.exit(0);
}

const [items, indices] = await Promise.all([
  Promise.all(codes.map(fetchKrxQuote)),
  Promise.all(['KOSPI', 'KOSDAQ'].map(fetchKrxIndex)),
]);
const payload = {
  version: 1,
  generatedAt: now.toISOString(),
  koreaDate: kst.date,
  marketStatus: items.every((item) => item.marketStatus === 'OPEN') ? 'OPEN' : items[0]?.marketStatus || 'UNKNOWN',
  source: 'NAVER_KRX_REGULAR',
  scope: 'KRX regular market only; NXT and integrated prices excluded',
  book,
  items,
  indices,
};

const envelope = encryptJson(payload, passphrase);
const outputPath = path.resolve(process.env.PRICE_OUTPUT_PATH || 'prices.enc.json');
await writeFile(outputPath, JSON.stringify(envelope), 'utf8');
console.log(JSON.stringify({ status: 'updated', output: outputPath, generatedAt: payload.generatedAt, count: items.length }));

async function fetchKrxQuote(code) {
  const response = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MJKH-Portfolio-Dashboard/1.0',
    },
  });
  if (!response.ok) throw new Error(`KRX quote request failed for ${code}: HTTP ${response.status}`);
  const body = await response.json();
  const quote = body?.datas?.[0];
  if (!quote || String(quote.itemCode).padStart(6, '0') !== code) throw new Error(`Invalid KRX quote payload for ${code}.`);

  const exchange = quote.stockExchangeType?.code || quote.stockExchangeType?.name || '';
  if (!['KOSPI', 'KOSDAQ', 'KS', 'KQ'].includes(exchange)) {
    throw new Error(`Unexpected exchange for ${code}: ${exchange}`);
  }

  // Deliberately read top-level KRX fields only. overMarketPriceInfo is NXT and
  // integratedPriceInfo combines markets, so both are excluded from this feed.
  const price = Number(quote.closePriceRaw);
  const previousClose = Number(quote.closePriceRaw) - Number(quote.compareToPreviousClosePriceRaw);
  const change = Number(quote.compareToPreviousClosePriceRaw);
  const returnRate = Number(quote.fluctuationsRatioRaw) / 100;
  if (![price, previousClose, change, returnRate].every(Number.isFinite) || price <= 0 || previousClose <= 0) {
    throw new Error(`Non-numeric KRX quote for ${code}.`);
  }
  return {
    code,
    price,
    previousClose,
    change,
    return: returnRate,
    tradedAt: quote.localTradedAt || null,
    marketStatus: quote.marketStatus || 'UNKNOWN',
    exchange,
  };
}

async function fetchKrxIndex(code) {
  const response = await fetch(`https://polling.finance.naver.com/api/realtime/domestic/index/${code}`, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MJKH-Portfolio-Dashboard/1.0',
    },
  });
  if (!response.ok) throw new Error(`KRX index request failed for ${code}: HTTP ${response.status}`);
  const body = await response.json();
  const quote = body?.datas?.[0];
  if (!quote || quote.itemCode !== code) throw new Error(`Invalid KRX index payload for ${code}.`);

  const price = Number(quote.closePriceRaw);
  const change = Number(quote.compareToPreviousClosePriceRaw);
  const previousClose = price - change;
  const returnRate = Number(quote.fluctuationsRatioRaw) / 100;
  if (![price, previousClose, change, returnRate].every(Number.isFinite) || price <= 0 || previousClose <= 0) {
    throw new Error(`Non-numeric KRX index quote for ${code}.`);
  }
  return {
    code,
    price,
    previousClose,
    change,
    return: returnRate,
    tradedAt: quote.localTradedAt || null,
    marketStatus: quote.marketStatus || 'UNKNOWN',
  };
}

function encryptJson(value, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const iterations = 310_000;
  const key = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    version: 1,
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function kstParts(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    label: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} KST`,
  };
}
