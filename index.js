const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE';

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
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
        console.error('QR Kod hatası:', err);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Bağlantı kapandı, yeniden bağlanılıyor:', shouldReconnect);
      connectionStatus = 'OFFLINE';
      currentQr = null;
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✓ WhatsApp Bağlantısı Başarıyla Kuruldu!');
      connectionStatus = 'CONNECTED';
      currentQr = null;
    }
  });

  // Fiyat yanıtlarını dinleyen mekanizma (Kesin Telefon Yakalamalı)
  sock.ev.on('messages.upsert', async (chatUpdate) => {
    try {
      const msg = chatUpdate.messages[0];
      if (!msg || !msg.message) return;

      const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

      if (contextInfo && contextInfo.quotedMessage) {
        const quotedText =
          contextInfo.quotedMessage.conversation ||
          contextInfo.quotedMessage.extendedTextMessage?.text ||
          '';

        console.log('🔍 [DEBUG] Alıntı Yapılan Orijinal Metin:\n', quotedText);
        console.log('💬 [DEBUG] Yazılan Fiyat Yanıtı:', messageContent);

        if (quotedText.includes('TEKLİF TALEBİ') || quotedText.includes('Müşteri') || quotedText.includes('Telefon')) {
          const offerPrice = messageContent ? messageContent.trim() : null;

          // Metindeki 05XX... veya 5XX... numarasını doğrudan çeker
          const phoneMatch = quotedText.match(/(?:05|905|5)\d{8,9}/);

          console.log('🔎 [DEBUG] Yakalanan Numara:', phoneMatch ? phoneMatch[0] : 'BULANAMADI');

          if (phoneMatch && offerPrice) {
            let rawPhone = phoneMatch[0].trim();

            let cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
            if (!cleanPhone.startsWith('90')) cleanPhone = '90' + cleanPhone;

            const targetJid = `${cleanPhone}@s.whatsapp.net`;
            console.log(`🎯 [DEBUG] Müşterinin Hedef JID:`, targetJid);

            const customerMessage = `Merhaba,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz incelenmiştir.\n\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamızda veya adresinizde nakit ödeme işleminizi anında tamamlayabiliriz.`;

            await sock.sendMessage(targetJid, { text: customerMessage });
            console.log(`✅ [BAŞARILI] Müşteriye (${targetJid}) mesaj iletildi!`);

            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            await sock.sendMessage(myJid, {
              text: `✓ *${offerPrice} TL* teklifiniz müşteriye (${cleanPhone}) başarıyla iletildi!`
            });
          } else {
            console.log('⚠️ [UYARI] Telefon numarası veya fiyat okunamadı.');
          }
        }
      }
    } catch (err) {
      console.error('❌ [HATA] messages.upsert Hatası:', err);
    }
  });
}

// REST API
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: currentQr,
    user: sock?.user?.id ? sock.user.id.split(':')[0] : null
  });
});

app.post('/logout', async (req, res) => {
  try {
    connectionStatus = 'OFFLINE';
    currentQr = null;

    // 1. WhatsApp Oturumunu Güvenli Şekilde Kapat (Patlarsa bile süreci durdurma)
    if (sock) {
      try {
        sock.ev.removeAllListeners(); // Olay dinleyicilerini temizle
        await sock.logout();
      } catch (e) {
        console.log('Sock logout uyarısı (yoksayıldı):', e.message);
      }
      sock = null;
    }

    // 2. Auth Klasörünü (auth_info_baileys) Fiziksel Olarak Temizle
    const authPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(authPath)) {
      try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log('🗑️ Eski oturum klasörü başarıyla silindi.');
      } catch (fsErr) {
        console.error('Klasör silme hatası:', fsErr.message);
      }
    }

    // 3. 1 Saniye Sonra Yeniden Bağlan ve Taze QR Kod Üret
    setTimeout(() => {
      connectToWhatsApp();
    }, 1000);

    return res.json({ success: true, message: 'Oturum kapatıldı, yeni QR üretiliyor.' });
  } catch (err) {
    console.error('Logout Genel Hatası:', err);
    return res.status(500).json({ error: err.message });
  }
});