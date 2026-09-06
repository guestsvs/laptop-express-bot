const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TARGET_GROUP_NAME = 'BOT'; 

// VERİTABANI DOSYALARI
const DB_FILE = path.join(__dirname, 'completed_offers.json'); // Tamamlanan işlemleri tutar
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');   // Grubun kalıcı JID kodunu tutar

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE';
let cachedGroupJid = null; 

// --- VERİTABANI VE AYAR FONKSİYONLARI ---
function getCompletedOffers() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveCompletedOffer(offerData) {
  let offers = getCompletedOffers();
  offers.push(offerData);
  if (offers.length > 50) offers = offers.slice(-50); // Son 50 işlemi tut
  fs.writeFileSync(DB_FILE, JSON.stringify(offers, null, 2));
}

function getSavedGroupJid() {
  if (cachedGroupJid) return cachedGroupJid;
  if (fs.existsSync(CONFIG_FILE)) {
    try { 
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data && data.groupJid) {
        cachedGroupJid = data.groupJid;
        return data.groupJid;
      }
    } catch (e) {}
  }
  return null;
}

function saveGroupJid(jid) {
  if (jid && jid !== cachedGroupJid) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ groupJid: jid }, null, 2));
    cachedGroupJid = jid;
    console.log(`💾 Grubun kalıcı JID kodu sisteme kazındı: ${jid}`);
  }
}
// ---------------------------------------

async function findGroupJidByName(groupName) {
  let savedJid = getSavedGroupJid();
  if (savedJid) return savedJid; // Varsa direkt kalıcı bellekten çek

  try {
    const groupList = await sock.groupFetchAllParticipating();
    for (const jid in groupList) {
      if (groupList[jid].subject && groupList[jid].subject.trim().toLowerCase() === groupName.trim().toLowerCase()) {
        let cleanJid = jid;
        if (cleanJid.endsWith('ag.us')) cleanJid = cleanJid.replace('ag.us', '@g.us'); // Hata düzeltme
        
        saveGroupJid(cleanJid); // Bulunca kalıcı hafızaya yaz
        return cleanJid;
      }
    }
  } catch (e) {
    console.error('Grup arama hatası:', e);
  }
  return null;
}

async function connectToWhatsApp() {
  try {
    const authFolderPath = path.join(__dirname, 'auth_info_baileys');
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      downloadHistory: false,
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 90000,
      defaultQueryTimeoutMs: 90000,
      retryRequestOptions: { maxRetries: 5 },
      browser: ['Laptop Express Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'CONNECTING';
        currentQr = await QRCode.toDataURL(qr).catch(() => null);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        const notifyJid = getSavedGroupJid();
        if (notifyJid && connectionStatus === 'CONNECTED') {
          try {
            await sock.sendMessage(notifyJid, { text: `🔴 *[SİSTEM DEVRE DIŞI]*\n\nBağlantı kesildi. Yeniden bağlanılıyor...` }).catch(() => null);
          } catch (e) {}
        }

        connectionStatus = 'OFFLINE';

        if (!isLoggedOut) {
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          currentQr = null;
          if (fs.existsSync(authFolderPath)) fs.rmSync(authFolderPath, { recursive: true, force: true });
          setTimeout(() => connectToWhatsApp(), 2000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'CONNECTED';
        currentQr = null;

        setTimeout(async () => {
          const groupJid = await findGroupJidByName(TARGET_GROUP_NAME);
          if (groupJid) {
            await sock.sendMessage(groupJid, {
              text: `🟢 *[SİSTEM AKTİF]*\n\nLaptop Express Bot başarıyla başlatıldı ve dinlemede.\n\n_Biten işlemleri görmek için gruba *\/tamamlananlar* yazabilirsiniz._`
            }).catch(() => null);
          }
        }, 3000);
      }
    });

    // MESAJLARI DİNLEME VE KOMUT YÖNETİMİ
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const msg = chatUpdate.messages[0];
        if (!msg || !msg.message) return;

        let fromJid = msg.key.remoteJid;
        if (fromJid.endsWith('ag.us')) fromJid = fromJid.replace('ag.us', '@g.us');
        
        // Gruptan herhangi bir mesaj gelirse (nokta bile olsa) ID'yi garantiye al
        if (fromJid.endsWith('@g.us')) {
          saveGroupJid(fromJid);
        }

        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

        // DİSCORD TARZI KOMUT: /tamamlananlar
        if (messageContent.trim().toLowerCase() === '/tamamlananlar') {
          const offers = getCompletedOffers();
          
          if (offers.length === 0) {
            await sock.sendMessage(fromJid, { text: '📭 *Kayıt Bulunamadı:*\nHenüz tamamlanan bir teklif işlemi yok.' });
            return;
          }

          const last5 = offers.slice(-5).reverse();
          let replyText = '✅ *SON 5 TAMAMLANAN TEKLİF*\n\n';
          
          last5.forEach((o, i) => {
            replyText += `${i + 1}️⃣ *Müşteri:* ${o.name}\n💰 *Fiyat:* ${o.price} TL\n📅 *Tarih:* ${o.date}\n📞 *İletişim:* ${o.phone}\n\n`;
          });

          await sock.sendMessage(fromJid, { text: replyText.trim() });
          return; 
        }

        // MÜŞTERİYE TEKLİF İLETME VE KAYIT ALTINA ALMA
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.quotedMessage) {
          const quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '';

          if (quotedText.includes('TEKLİF TALEBİ') || quotedText.includes('Müşteri')) {
            const offerPrice = messageContent ? messageContent.trim() : null;
            const phoneMatch = quotedText.match(/(?:05|905|5)\d{8,9}/);
            const nameMatch = quotedText.match(/Müşteri:\s*([^\n\*]+)/);
            const customerName = nameMatch ? nameMatch[1].trim() : 'Belirtilmedi';

            if (phoneMatch && offerPrice && !isNaN(offerPrice)) {
              let rawPhone = phoneMatch[0].trim();
              let cleanPhone = rawPhone.replace(/\D/g, '');
              if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
              if (!cleanPhone.startsWith('90')) cleanPhone = '90' + cleanPhone;

              const targetJid = `${cleanPhone}@s.whatsapp.net`;
              const customerMessage = `Merhaba,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz incelenmiştir.\n\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamızda veya adresinizde nakit ödeme işleminizi anında tamamlayabiliriz.`;

              // Müşteriye Gönder
              await sock.sendMessage(targetJid, { text: customerMessage });

              // Veritabanına Kaydet
              const now = new Date();
              const dateStr = now.toLocaleDateString('tr-TR') + ' ' + now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
              
              saveCompletedOffer({ name: customerName, phone: cleanPhone, price: offerPrice, date: dateStr });

              // Gruba Onay Bildirimi
              await sock.sendMessage(fromJid, { text: `✓ *${offerPrice} TL* teklif müşteriye başarıyla iletildi ve kayıt altına alındı.` });
            }
          }
        }
      } catch (err) {
        console.error('❌ Mesaj işleme hatası:', err);
      }
    });

  } catch (err) {
    console.error('WhatsApp Ana Bağlantı Hatası:', err);
  }
}

app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr,
    user: sock?.user?.id ? sock.user.id.split(':')[0].split('@')[0] : null
  });
});

app.post('/send-offer', async (req, res) => {
  try {
    const offer = req.body;
    if (!offer || !offer.telefon) return res.status(400).json({ error: 'Eksik teklif verisi' });

    const offerId = offer.id || 'Yeni';
    const adminNotification = `📩 *YENİ TEKLİF TALEBİ (#${offerId})*\n\n` +
      `👤 *Müşteri:* ${offer.musteri_adi || 'Belirtilmedi'}\n` +
      `📞 *Telefon:* ${offer.telefon}\n` +
      `💻 *İşlemci:* ${offer.islemci || '-'}\n` +
      `🎮 *Ekran Kartı:* ${offer.ekran_karti || '-'}\n` +
      `⚡ *RAM / SSD:* ${offer.ram || '-'} / ${offer.ssd || '-'}\n` +
      `✨ *Kozmetik / Durum:* ${offer.kozmetik || '-'} / ${offer.kullanim_durumu || '-'}\n\n` +
      `💡 *Fiyat Vermek İçin:* Bu mesaja "Yanıtla (Reply)" yaparak vermek istediğiniz rakamı (sadece sayı olarak, örn: 18500) yazın.`;

    if (sock && connectionStatus === 'CONNECTED') {
      const groupJid = await findGroupJidByName(TARGET_GROUP_NAME);

      if (groupJid) {
        try {
          await sock.sendMessage(groupJid, { text: adminNotification });
          return res.json({ success: true, message: 'Gruba bildirim gönderildi.' });
        } catch (sendErr) {
          console.error('Gruba atılamadı:', sendErr);
          return res.status(500).json({ error: 'Gruba mesaj atılamadı.' });
        }
      } else {
        // GRUP BULUNAMAZSA KİŞİSEL SOHBETE GİTMESİ TAMAMEN İPTAL EDİLDİ!
        console.error(`⚠️ "${TARGET_GROUP_NAME}" isimli grup bulunamadı. Mesaj iptal edildi.`);
        return res.status(404).json({ error: 'WhatsApp grubu bulunamadı, mesaj gönderimi iptal edildi.' });
      }
    } else {
      return res.status(503).json({ error: 'WhatsApp botu henüz bağlı değil' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    connectionStatus = 'OFFLINE';
    currentQr = null;

    if (sock) {
      sock.ev.removeAllListeners();
      await sock.logout().catch(()=>{});
      sock = null;
    }

    const authFolderPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authFolderPath)) fs.rmSync(authFolderPath, { recursive: true, force: true });

    setTimeout(() => connectToWhatsApp(), 1000);
    return res.json({ success: true, message: 'Oturum kapatıldı' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bot servisi ${PORT} portunda çalışıyor.`);
  setTimeout(() => connectToWhatsApp(), 2000);
});
