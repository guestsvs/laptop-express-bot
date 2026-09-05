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

// Render Environment'tan gelen Grup JID Adresi
let TARGET_GROUP_JID = process.env.TARGET_GROUP_JID || null;

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE';

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
      retryRequestOptions: {
        maxRetries: 5
      },
      browser: ['Laptop Express Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'CONNECTING';
        try {
          currentQr = await QRCode.toDataURL(qr);
          console.log('⚡ Yeni QR Kod Üretildi!');
        } catch (err) {
          console.error('QR Kod oluşturma hatası:', err);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`⚠️ Bağlantı kapandı. Durum Kodu: ${statusCode}. Oturum kapatıldı mı: ${isLoggedOut}`);
        connectionStatus = 'OFFLINE';

        if (!isLoggedOut) {
          console.log('🔄 Geçici kopma. Tekrar bağlanılıyor...');
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          console.log('❌ Kullanıcı oturumu kapattı. Klasör sıfırlanıyor...');
          currentQr = null;
          if (fs.existsSync(authFolderPath)) {
            try {
              fs.rmSync(authFolderPath, { recursive: true, force: true });
            } catch (e) {}
          }
          setTimeout(() => connectToWhatsApp(), 2000);
        }
      } else if (connection === 'open') {
        console.log('✅ [BAŞARILI] WhatsApp Bağlantısı Tamamen Kuruldu!');
        connectionStatus = 'CONNECTED';
        currentQr = null;
      }
    });

    // MESAJ İŞLEME MEKANİZMASI
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const msg = chatUpdate.messages[0];
        if (!msg || !msg.message) return;

        const fromJid = msg.key.remoteJid;
        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

        if (fromJid.endsWith('@g.us')) {
          console.log(`📌 GRUP MESAJI ALGILANDI! Grup JID Adresi: ${fromJid}`);
        }

        // MÜŞTERİYE TEKLİF İLETME (Yanıtla Yapıldığında)
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

        if (contextInfo && contextInfo.quotedMessage) {
          const quotedText =
            contextInfo.quotedMessage.conversation ||
            contextInfo.quotedMessage.extendedTextMessage?.text ||
            '';

          if (quotedText.includes('TEKLİF TALEBİ') || quotedText.includes('Müşteri') || quotedText.includes('Telefon')) {
            const offerPrice = messageContent ? messageContent.trim() : null;
            const phoneMatch = quotedText.match(/(?:05|905|5)\d{8,9}/);

            if (phoneMatch && offerPrice) {
              let rawPhone = phoneMatch[0].trim();
              let cleanPhone = rawPhone.replace(/\D/g, '');
              if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
              if (!cleanPhone.startsWith('90')) cleanPhone = '90' + cleanPhone;

              const targetJid = `${cleanPhone}@s.whatsapp.net`;
              const customerMessage = `Merhaba,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz incelenmiştir.\n\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamızda veya adresinizde nakit ödeme işleminizi anında tamamlayabiliriz.`;

              // Müşteriye Gönder
              await sock.sendMessage(targetJid, { text: customerMessage });
              console.log(`✅ Müşteriye (${targetJid}) teklif iletildi: ${offerPrice} TL`);

              // Yanıt verilen sohbete (Gruba) onay bildirimi geç
              await sock.sendMessage(fromJid, {
                text: `✓ *${offerPrice} TL* teklifiniz müşteriye (${cleanPhone}) başarıyla iletildi!`
              });
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

// ROTALAR
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
    if (!offer || !offer.telefon) {
      return res.status(400).json({ error: 'Eksik teklif verisi' });
    }

    const offerId = offer.id || 'Yeni';
    const adminNotification = `📩 *YENİ TEKLİF TALEBİ (#${offerId})*\n\n` +
      `👤 *Müşteri:* ${offer.musteri_adi || 'Belirtilmedi'}\n` +
      `📞 *Telefon:* ${offer.telefon}\n` +
      `💻 *İşlemci:* ${offer.islemci || '-'}\n` +
      `🎮 *Ekran Kartı:* ${offer.ekran_karti || '-'}\n` +
      `⚡ *RAM / SSD:* ${offer.ram || '-'} / ${offer.ssd || '-'}\n` +
      `✨ *Kozmetik / Durum:* ${offer.kozmetik || '-'} / ${offer.kullanim_durumu || '-'}\n\n` +
      `💡 *Fiyat Vermek İçin:* Bu mesaja "Yanıtla (Reply)" yaparak vermek istediğiniz rakamı yazın (Örn: 18500).`;

    if (sock && connectionStatus === 'CONNECTED') {
      let targetJid = process.env.TARGET_GROUP_JID ? process.env.TARGET_GROUP_JID.trim() : null;

      if (targetJid) {
        try {
          // Gruba göndermeden önce grup bilgilerini senkronize et (Internal Server Error önlemi)
          await sock.groupMetadata(targetJid).catch(() => null);
          await sock.sendMessage(targetJid, { text: adminNotification });
          console.log(`✅ Teklif bildirimi gruba (${targetJid}) başarıyla gönderildi.`);
          return res.json({ success: true, message: 'Gruba bildirim gönderildi.' });
        } catch (groupErr) {
          console.error('❌ Gruba mesaj atılamadı, kişisel sohbete düşülüyor:', groupErr);
        }
      }

      // Grup yoksa veya hata verdiyse doğrudan kendi sohbetine gönder
      const userNumber = sock.user.id.split(':')[0].split('@')[0];
      const myJid = `${userNumber}@s.whatsapp.net`;
      await sock.sendMessage(myJid, { text: adminNotification });
      console.log(`✅ Teklif bildirimi kişisel sohbetinize (${myJid}) gönderildi.`);

      return res.json({ success: true, message: 'Bildirim gönderildi.' });
    } else {
      return res.status(503).json({ error: 'WhatsApp botu henüz bağlı değil' });
    }
  } catch (error) {
    console.error('send-offer Hata:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    connectionStatus = 'OFFLINE';
    currentQr = null;

    if (sock) {
      try {
        sock.ev.removeAllListeners();
        await sock.logout();
      } catch (e) {}
      sock = null;
    }

    const authFolderPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authFolderPath)) {
      try {
        fs.rmSync(authFolderPath, { recursive: true, force: true });
      } catch (e) {}
    }

    setTimeout(() => {
      connectToWhatsApp();
    }, 1000);

    return res.json({ success: true, message: 'Oturum kapatıldı' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bot servisi ${PORT} portunda çalışıyor.`);
  setTimeout(() => {
    connectToWhatsApp();
  }, 2000);
});
