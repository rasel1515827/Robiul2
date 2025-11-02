import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import axios from 'axios';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { COUNTRY_FLAGS, COUNTRY_NAME_TO_CODE } from './countries.js';
import {
    USERNAME,
    PASSWORD,
    BOT_TOKEN,
    CHAT_ID,
    REFRESH_INTERVAL_MINUTES,
    MAIN_CHANNEL_NAME,
    MAIN_CHANNEL_URL,
    ADMIN_NAME,
    ADMIN_URL
} from './env.js';

// âœ… ffmpeg initialize
ffmpeg.setFfmpegPath(ffmpegPath);

// ==============================================================================
// Logger
// ==============================================================================
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot_log.txt', level: 'info' })
    ]
});

// ==============================================================================
// Helper functions
// ==============================================================================
const getCountryFlag = (countryName) => {
    const countryNameUpper = countryName.trim().toUpperCase();
    const countryCode = COUNTRY_NAME_TO_CODE[countryNameUpper];
    return COUNTRY_FLAGS[countryCode] || 'ðŸŒ';
};

// âœ… Mask Number (3 digit + *** + last 4 digit)
const maskNumber = (number) => {
    const numStr = String(number).trim();
    return numStr.length > 7
        ? `${numStr.substring(0, 3)}***${numStr.substring(numStr.length - 4)}`
        : numStr;
};

const extractCountryFromTermination = (text) => {
    const parts = text.split(' ');
    const countryParts = [];
    for (const part of parts) {
        if (['MOBILE', 'FIXED'].includes(part.toUpperCase()) || /\d/.test(part)) {
            break;
        }
        countryParts.push(part);
    }
    return countryParts.length > 0 ? countryParts.join(' ') : text;
};

// âœ… Message deletion function
const deleteTelegramMessage = async (messageId) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
    try {
        await axios.post(url, {
            chat_id: CHAT_ID,
            message_id: messageId
        });
        logger.info(`âœ… Message ${messageId} deleted successfully.`);
        return true;
    } catch (e) {
        logger.error(`âŒ Failed to delete message ${messageId}: ${e.response?.data?.description || e.message}`);
        return false;
    }
};

// âœ… Safe audio sender
const sendAudioToTelegramGroup = async (caption, filePath) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', caption);
    form.append('audio', fs.createReadStream(filePath));
    form.append('reply_markup', JSON.stringify({
        inline_keyboard: [
            [
                { text: `ðŸ“¢ ${MAIN_CHANNEL_NAME}`, url: MAIN_CHANNEL_URL },
                { text: `ðŸ‘® ${ADMIN_NAME}`, url: ADMIN_URL }
            ]
        ]
    }));

    try {
        await axios.post(url, form, { headers: form.getHeaders(), timeout: 30000 });
        logger.info("âœ”ï¸ Audio file sent to Telegram successfully.");
        return true;
    } catch (e) {
        logger.error(`âŒ Failed to send audio file: ${e.response?.data?.description || e.message}`);
        return false;
    }
};

// ==========================
// Instant Notification - SIMPLE TEXT
// ==========================
const sendInstantNotification = async (callData) => {
    const { country, number, cliNumber } = callData;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    
    const message =
        `${getCountryFlag(country)} Country: ${country}\n` +
        `ðŸ“ž Number: ${maskNumber(number)}\n` +
        `âš¡ï¸ New call received!\n` +
        `â³ please waiting...............`;

    try {
        const response = await axios.post(url, {
            chat_id: CHAT_ID,
            text: message,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `ðŸ“¢ ${MAIN_CHANNEL_NAME}`, url: MAIN_CHANNEL_URL },
                        { text: `ðŸ‘® ${ADMIN_NAME}`, url: ADMIN_URL }
                    ]
                ]
            }
        });

        const messageId = response.data.result.message_id;
        logger.info(`âœ… Instant notification sent for ${cliNumber} (Message ID: ${messageId})`);

        return messageId;

    } catch (e) {
        logger.error(`âŒ Failed to send instant notification: ${e.response?.data?.description || e.message}`);
        return null;
    }
};

// ==============================================================================
// Login system
// ==============================================================================
const loginToDashboard = async ({ headless = false, maxRetries = 2 } = {}) => {
    let browser = null;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            browser = await puppeteer.launch({
                headless,
                defaultViewport: null,
                args: ["--no-sandbox", "--disable-setuid-sandbox"]
            });

            const page = await browser.newPage();

            logger.info("ðŸŒ Opening login page...");
            await page.goto("https://www.orangecarrier.com/login", {
                waitUntil: "networkidle2",
                timeout: 60000,
            });

            logger.info("â³ Waiting 5 sec before scanning form...");
            await new Promise(r => setTimeout(r, 5000));

            const inputs = await page.$$("input");
            let emailField = null, passField = null;

            for (const input of inputs) {
                const attrs = await input.evaluate(el => ({
                    type: el.getAttribute("type"),
                    placeholder: el.getAttribute("placeholder"),
                    name: el.getAttribute("name"),
                    id: el.getAttribute("id"),
                }));

                if (!emailField && (attrs.type === "email" 
                    || (attrs.placeholder && attrs.placeholder.toLowerCase().includes("email")) 
                    || (attrs.name && attrs.name.toLowerCase().includes("email")) 
                    || (attrs.id && attrs.id.toLowerCase().includes("email")))) {
                    emailField = input;
                }
                if (!passField && attrs.type === "password") {
                    passField = input;
                }
            }

            if (emailField && passField) {
                logger.info("âœ… Email & Password fields detected! Auto filling...");
                await emailField.type(USERNAME, { delay: 100 });
                await passField.type(PASSWORD, { delay: 100 });
            } else {
                throw new Error("Could not detect email or password field!");
            }

            let loginBtn = await page.$("button[type=submit], input[type=submit]");
            if (!loginBtn) {
                const signInBtns = await page.$x("//button[contains(., 'Sign In')]");
                if (signInBtns.length > 0) loginBtn = signInBtns[0];
            }

            if (loginBtn) {
                logger.info("ðŸ‘‰ Clicking Sign In button...");
                await Promise.all([
                    loginBtn.click(),
                    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null),
                ]);
            } else {
                throw new Error("Sign In button not found!");
            }

            const currentUrl = page.url();
            if (currentUrl.includes("orangecarrier.com")) {
                const pageContent = await page.content();
                if (pageContent.includes("Dashboard") || pageContent.includes("Account Code")) {
                    logger.info("ðŸŽ‰ Login successful! Dashboard detected.");

                    const liveCallsUrl = "https://www.orangecarrier.com/live/calls";
                    await page.goto(liveCallsUrl, { waitUntil: "networkidle2" });
                    const cookies = await page.cookies();

                    return { browser, page, cookies };
                }
            }

            throw new Error("Login failed or dashboard not detected.");
        } catch (err) {
            attempt++;
            logger.error(`âŒ Login attempt ${attempt} failed: ${err.message}`);
            if (browser) await browser.close();
            browser = null;
            if (attempt >= maxRetries) return null;
            logger.info("ðŸ”„ Retrying login...");
        }
    }
    return null;
};

// ==============================================================================
// Process Call Worker (WAV â†’ MP3 Convert & Send to Telegram)
// ==============================================================================
const processCallWorker = async (callData, cookies, page, notificationMessageId) => {
    const { country, number, cliNumber, audioUrl } = callData;

    try {
        const fileName = `call_${Date.now()}_${cliNumber}.wav`;
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const filePath = path.join(__dirname, fileName);

        const headers = {
            Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
            "User-Agent": "Mozilla/5.0",
        };

        // --- Download audio (WAV) ---
        const response = await axios.get(audioUrl, {
            headers,
            responseType: "arraybuffer",
            timeout: 30000,
        });

        fs.writeFileSync(filePath, Buffer.from(response.data), "binary");
        logger.info(`ðŸŽ§ Audio file downloaded (WAV): ${fileName}`);

        // --- WAV â†’ MP3 Convert ---
        const filePathMp3 = filePath.replace(".wav", ".mp3");
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .audioCodec("libmp3lame")
                .toFormat("mp3")
                .on("end", () => {
                    logger.info(`ðŸ”„ Converted to MP3: ${path.basename(filePathMp3)}`);
                    resolve();
                })
                .on("error", (err) => {
                    logger.error(`âŒ FFmpeg conversion error: ${err.message}`);
                    reject(err);
                })
                .save(filePathMp3);
        });

        // âœ… Send MP3 to Telegram - SIMPLE TEXT
        const caption =
            `${getCountryFlag(country)} Country: ${country}\n` +
            `ðŸ“ž Number: ${maskNumber(number)}\n` +
            `â–¶ï¸ Play audio for OTP\n` +
            `ðŸ‘¨â€ðŸ’» Made by BD Tech Monirul`;

        await sendAudioToTelegramGroup(caption, filePathMp3);

        // âœ… Delete the initial notification message
        if (notificationMessageId) {
            await deleteTelegramMessage(notificationMessageId);
        }

        // --- Clean up ---
        fs.unlinkSync(filePath);
        fs.unlinkSync(filePathMp3);
        logger.info("ðŸ—‘ Temporary files deleted.");
    } catch (e) {
        logger.error(`âŒ Error processing call for ${cliNumber}: ${e.message}`);
    }
};

// ==============================================================================
// Main
// ==============================================================================
const main = async () => {
    let browser = null;
    try {
        // âœ… FIXED: Changed maxRetries = 2 to maxRetries: 2
        const session = await loginToDashboard({ headless: false, maxRetries: 2 });
        if (!session) {
            logger.error("ðŸ”´ Could not login after multiple attempts.");
            return;
        }

        browser = session.browser;
        const page = session.page;
        const cookies = session.cookies;

        const processedCalls = new Set();
        logger.info("\nðŸš€ Monitoring started...");

        // keep session alive
        setInterval(async () => {
            logger.info(`ðŸ•’ ${REFRESH_INTERVAL_MINUTES} minutes passed. Refreshing page...`);
            try {
                await page.reload({ waitUntil: 'networkidle2' });
                logger.info("âœ… Page refreshed successfully.");
            } catch (e) {
                logger.error(`ðŸ”´ Page refresh failed: ${e.message}`);
            }
        }, REFRESH_INTERVAL_MINUTES * 60 * 1000);

        // --- Monitoring loop ---
        while (true) {
            try {
                const pageHtml = await page.content();
                const $ = cheerio.load(pageHtml);

                $('#LiveCalls tr, #last-activity tbody.lastdata tr').each((i, row) => {
                    const columns = $(row).find('td');
                    if (columns.length > 2) {
                        const cliNumber = $(columns[2]).text().trim();

                        const playButton = $(row).find("button[onclick*='Play']");
                        if (playButton.length) {
                            const onclickAttr = playButton.attr('onclick');
                            const matches = onclickAttr.match(/Play\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/);
                            if (matches) {
                                const [, did, uuid] = matches;

                                const callId = `${cliNumber}_${uuid}`; // âœ… Unique ID
                                if (!processedCalls.has(callId)) {
                                    processedCalls.add(callId);

                                    const callData = {
                                        country: extractCountryFromTermination($(columns[0]).text().trim()),
                                        number: $(columns[1]).text().trim(),
                                        cliNumber: cliNumber,
                                        audioUrl: `https://www.orangecarrier.com/live/calls/sound?did=${did}&uuid=${uuid}`
                                    };

                                    // 1ï¸âƒ£ Send instant notification and get message ID
                                    sendInstantNotification(callData).then(notificationMessageId => {
                                        if (notificationMessageId) {
                                            logger.info(`ðŸ“ž New call detected (${cliNumber}), scheduling audio after 20s...`);

                                            // 2ï¸âƒ£ Schedule audio processing after 20s with notification message ID
                                            setTimeout(() => {
                                                processCallWorker(callData, cookies, page, notificationMessageId)
                                                    .catch(err => logger.error(`âŒ Call processing failed for ${cliNumber}: ${err.message}`));
                                            }, 20000);
                                        }
                                    }).catch(err => 
                                        logger.error(`âŒ Notification failed for ${cliNumber}: ${err.message}`)
                                    );
                                }
                            }
                        }
                    }
                });

            } catch (e) {
                logger.error(`ðŸ”´ Unexpected error in monitoring loop: ${e.message}`);
                await new Promise(resolve => setTimeout(resolve, 15000));
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

    } catch (e) {
        logger.error(`ðŸ”´ Browser or driver crashed! Error: ${e.message}`);
    } finally {
        if (browser) {
            logger.info("Stopping the bot.");
            await browser.close();
        }
    }
};

main();
