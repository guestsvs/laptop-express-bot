const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Supabase Bağlantısı
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://mvqkljryofiaaxbocsqq.supabase.co/rest/v1/';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12cWtsanJ5b2ZpYWF4Ym9jc3FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcxMzAzOTUsImV4cCI6MjEwMjcwNjM5NX0.FeeZZSnjhHfd8TX2DXv-4JakjYg3YoEWFIv_aHq5akg';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE';

// DÜZELTİLMİŞ VE SAF SUPABASE AUTH ADAPTER (Sonsuz Döngüyü Kırar)
async function useSupabaseAuthState() {
  const writeData = async (data, id) => {
    try {
      await supabase
        .from('whatsapp_session')
        .upsert({ id, data: JSON.stringify(data, BufferJSON.replacer) });
    } catch (err) {
      console.error('Supabase write error:', err);
    }
  };

  const readData = async (id) => {
    try {
      const { data, error } = await supabase
        .from('whatsapp_session')
        .select('data')
        .eq('id', id)
        .single();

      if (error || !data) return null;
      return JSON.parse(data.data, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await supabase.from('whatsapp_session').delete().eq('id', id);
    } catch (err) {
      console.error('Supabase delete error:', err);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useSupabaseAuthState();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      downloadHistory: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        console.log(`⚠️ Bağlantı kapandı. Kod: ${statusCode}. Tamamen kapandı mı: ${isLoggedOut}`);
        connectionStatus = 'OFFLINE';

        if (!isLoggedOut) {
          console.log('🔄 Oturum geçerli. 3 saniye içinde tekrar bağlanılıyor...');
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          console.log('❌ Oturum kapatıldı. Supabase oturum verileri temizleniyor...');
          currentQr = null;
          await supabase.from('whatsapp_session').delete().neq('id', '___');
          setTimeout(() => connectToWhatsApp(), 2000);
        }
      } else if (connection === 'open') {
        console.log('✓ WhatsApp Bağlantısı Başarıyla Kuruldu (Supabase Destekli)!');
        connectionStatus = 'CONNECTED';
        currentQr = null;
      }
    });

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

              await sock.sendMessage(targetJid, { text: customerMessage });
              console.log(`✅ [BAŞARILI] Müşteriye (${targetJid}) mesaj iletildi!`);

              const userNumber = sock.user.id.split(':')[0].split('@')[0];
              const myJid = `${userNumber}@s.whatsapp.net`;

              await sock.sendMessage(myJid, {
                text: `✓ *${offerPrice} TL* teklifiniz müşteriye (${cleanPhone}) başarıyla iletildi!`
              });
            }
          }
        }
      } catch (err) {
        console.error('❌ [HATA] messages.upsert Hatası:', err);
      }
    });
  } catch (err) {
    console.error('WhatsApp Bağlantı Hatası:', err);
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
      const userNumber = sock.user.id.split(':')[0].split('@')[0];
      const myJid = `${userNumber}@s.whatsapp.net`;

      await sock.sendMessage(myJid, { text: adminNotification });
      return res.json({ success: true, message: 'Bildirim gönderildi.' });
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
      try {
        sock.ev.removeAllListeners();
        await sock.logout();
      } catch (e) {}
      sock = null;
    }

    await supabase.from('whatsapp_session').delete().neq('id', '___');

    setTimeout(() => {
      connectToWhatsApp();
    }, 1000);

    return res.json({ success: true, message: 'Oturum kapatıldı' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bot servisi ${PORT} portunda başarıyla ayağa kalktı.`);
  setTimeout(() => {
    connectToWhatsApp();
  }, 2000);
});
