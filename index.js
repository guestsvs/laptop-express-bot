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
const TARGET_GROUP_NAME = 'LAPTOP EXPRESS BOT'; 

// KALICI HAFIZA VE VERİTABANI DOSYALARI
const DB_FILE = path.join(__dirname, 'completed_offers.json'); 
const CONFIG_FILE = path.join(__dirname, 'bot_config.json');   
const PENDING_FILE = path.join(__dirname, 'pending_offers.json');

let sock = null;
let currentQr = null;
let connectionStatus = 'OFFLINE';
let cachedGroupJid = null; 

// --- VERİTABANI VE TAKİP YÖNETİMİ ---
function getCompletedOffers() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveCompletedOffer(offerData) {
  let offers = getCompletedOffers();
  offers.push(offerData);
  if (offers.length > 200) offers = offers.slice(-200);
  fs.writeFileSync(DB_FILE, JSON.stringify(offers, null, 2));
}

function getStats() {
  const offers = getCompletedOffers();
  const totalOffers = offers.length;
  const totalVolume = offers.reduce((sum, offer) => sum + (parseFloat(offer.price) || 0), 0);
  return { totalOffers, totalVolume };
}

// Bekleyen ve Takip Edilecek Teklifler
function getPendingOffers() {
  if (fs.existsSync(PENDING_FILE)) {
    try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function savePendingOffer(data) {
  let pending = getPendingOffers();
  pending.push(data);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
}

function removePendingOffer(offerId) {
  let pending = getPendingOffers();
  pending = pending.filter(p => p.id !== offerId);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
}

function updatePendingOffer(offerId, updateData) {
  let pending = getPendingOffers();
  const index = pending.findIndex(p => p.id === offerId);
  if (index !== -1) {
    pending[index] = { ...pending[index], ...updateData };
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2));
  }
}

// --- JID (GRUP ID) KALICI HAFIZA ---
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
  }
}

async function findGroupJidByName(groupName) {
  let savedJid = getSavedGroupJid();
  if (savedJid) return savedJid;

  try {
    const groupList = await sock.groupFetchAllParticipating();
    for (const jid in groupList) {
      if (groupList[jid].subject && groupList[jid].subject.trim().toLowerCase() === groupName.trim().toLowerCase()) {
        let cleanJid = jid;
        if (cleanJid.endsWith('ag.us')) cleanJid = cleanJid.replace('ag.us', '@g.us');
        saveGroupJid(cleanJid); 
        return cleanJid;
      }
    }
  } catch (e) {}
  return null;
}

// --- ZAMAN AŞIMI VE OTOMATİK TAKİP KONTROLÜ ---
function startBackgroundJobs() {
  setInterval(async () => {
    if (!sock || connectionStatus !== 'CONNECTED') return;

    const groupJid = getSavedGroupJid();
    const pending = getPendingOffers();
    const now = Date.now();

    for (const offer of pending) {
      if (offer.status === 'WAITING_RESPONSE' && !offer.timeoutWarned && (now - offer.createdAt > 24 * 60 * 60 * 1000)) {
        if (groupJid) {
          await sock.sendMessage(groupJid, {
            text: `⚠️ *[ZAMAN AŞIMI UYARISI]*\n\n#${offer.id} numaralı teklif talebi 24 saattir yanıt bekliyor!`
          }).catch(() => null);
        }
        updatePendingOffer(offer.id, { timeoutWarned: true });
      }

      if (offer.status === 'OFFER_SENT' && !offer.followUpSent && (now - offer.offerSentAt > 6 * 60 * 60 * 1000)) {
        const targetJid = `${offer.phone}@s.whatsapp.net`;
        const followUpMsg = `Merhaba,\n\nLaptop Express üzerinden ilettiğimiz fiyat teklifini değerlendirme fırsatınız oldu mu? Aklınıza takılan bir detay varsa yardımcı olmaktan mutluluk duyarız.`;
        
        await sock.sendMessage(targetJid, { text: followUpMsg }).catch(() => null);
        
        if (groupJid) {
          await sock.sendMessage(groupJid, {
            text: `📩 Müşteriye (${offer.phone}) teklif sonrası otomatik takip (follow-up) mesajı iletildi.`
          }).catch(() => null);
        }
        updatePendingOffer(offer.id, { followUpSent: true });
      }
    }
  }, 5 * 60 * 1000);
}

// --- BAĞLANTI ANA GÖVDESİ ---
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
            await sock.sendMessage(notifyJid, { text: `🔴 *[SİSTEM DEVRE DIŞI]*\nBot bağlantısı kesildi. Yeniden bağlanıyor...` }).catch(() => null);
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
              text: `🟢 *[SİSTEM AKTİF]*\n\nLaptop Express CRM Bot başarıyla başlatıldı.\nKomutları görmek için gruba */yardım* yazabilirsiniz.`
            }).catch(() => null);
          }
        }, 3000);
      }
    });

    // --- MESAJ (KOMUT) İŞLEYİCİ MANTIK ---
    sock.ev.on('messages.upsert', async (chatUpdate) => {
      try {
        const msg = chatUpdate.messages[0];
        if (!msg || !msg.message) return;

        let fromJid = msg.key.remoteJid;
        if (fromJid.endsWith('ag.us')) fromJid = fromJid.replace('ag.us', '@g.us');
        
        if (fromJid.endsWith('@g.us')) saveGroupJid(fromJid);

        const messageContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const command = messageContent.trim().toLowerCase();

        // 1. DİREKT GRUBA YAZILAN BİLGİ VE YÖNETİM KOMUTLARI
        if (command === '/yardım' || command === '!yardım') {
          const helpText = `🤖 *LAPTOP EXPRESS BOT KOMUTLARI*\n\n` +
            `📌 *GENEL KOMUTLAR*\n` +
            `• */yardım* : Komut listesini gösterir.\n` +
            `• */tamamlananlar* : Son 5 başarılı teklifi listeler.\n` +
            `• */istatistik* : Toplam teklif ve hacim verisini sunar.\n` +
            `• *!sil* veya */sil* : Grup sohbetini temizler.\n\n` +
            `⚡ *TEKLİF YANITLAMA KOMUTLARI (Teklif Mesajını Yanıtlayarak)*\n` +
            `• *[Fiyat]* (Örn: 18500) : Fiyat teklifini müşteriye iletir.\n` +
            `• */eksik* : Müşteriden cihaz ve telefon fotoğraflarını talep eder.\n` +
            `• */red* : Teklif talebini kibarca reddeder.\n` +
            `• */anket* : Müşteriye değerlendirme linki gönderir.`;
          
          await sock.sendMessage(fromJid, { text: helpText });
          return;
        }

        if (command === '!sil' || command === '/sil') {
          try {
            await sock.chatModify(
              { delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] },
              fromJid
            );
          } catch (cleanErr) {
            await sock.sendMessage(fromJid, { text: `⚠️ Sohbet temizleme işlemi başarısız oldu.` });
          }
          return;
        }

        if (command === '/tamamlananlar' || command === '!tamamlananlar') {
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

        if (command === '/istatistik' || command === '!istatistik') {
          const stats = getStats();
          const statText = `📊 *MAĞAZA İSTATİSTİKLERİ*\n\n` +
            `📦 *Toplam Verilen Teklif:* ${stats.totalOffers} adet\n` +
            `💸 *Toplam Teklif Hacmi:* ${stats.totalVolume.toLocaleString('tr-TR')} TL`;
          await sock.sendMessage(fromJid, { text: statText });
          return;
        }

        // 2. MÜŞTERİ TEKLİFİNE VERİLEN YANITLAR
        const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
        if (contextInfo && contextInfo.quotedMessage) {
          const quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || '';

          if (quotedText.includes('YENİ TEKLİF TALEBİ') || quotedText.includes('Müşteri')) {
            const phoneMatch = quotedText.match(/(?:05|905|5)\d{8,9}/);
            const offerIdMatch = quotedText.match(/#([A-Za-z0-9_\-]+)/);
            const nameMatch = quotedText.match(/Müşteri:\s*([^\n\*]+)/);
            
            const customerName = nameMatch ? nameMatch[1].trim() : 'Belirtilmedi';
            const offerId = offerIdMatch ? offerIdMatch[1] : null;

            if (phoneMatch) {
              let cleanPhone = phoneMatch[0].trim().replace(/\D/g, '');
              if (cleanPhone.startsWith('0')) cleanPhone = cleanPhone.substring(1);
              if (!cleanPhone.startsWith('90')) cleanPhone = '90' + cleanPhone;
              const targetJid = `${cleanPhone}@s.whatsapp.net`;

              // YANIT 1: EKSİK BİLGİ TALEBİ (/eksik)
              if (command === '/eksik' || command === '!eksik') {
                const eksikMesaj = `Merhaba,\n\nLaptop Express'e ilettiğiniz cihaz teklif talebiniz uzmanlarımız tarafından incelenmektedir.\n\nCihazınıza en doğru ve net değeri biçebilmemiz için lütfen cihazın ve telefonun net fotoğraflarını (kasa, ekran, klavye) bu sohbete iletir misiniz?`;
                await sock.sendMessage(targetJid, { text: eksikMesaj });
                await sock.sendMessage(fromJid, { text: `⚠️ Müşteriye (${cleanPhone}) detaylı cihaz ve telefon fotoğrafı talebi gönderildi.` });
                
                if (offerId) removePendingOffer(offerId);
                return;
              }

              // YANIT 2: TEKLİF REDDİ (/red)
              if (command === '/red' || command === '!red') {
                const redMesaj = `Merhaba,\n\nLaptop Express'e ilettiğiniz teklif talebiniz incelenmiştir.\n\nMaalesef ilettiğiniz cihaz modeliniz veya durumu şu anki mağaza alım kriterlerimize uymamaktadır. İlginize teşekkür eder, iyi günler dileriz.`;
                await sock.sendMessage(targetJid, { text: redMesaj });
                await sock.sendMessage(fromJid, { text: `❌ Müşteriye (${cleanPhone}) ret mesajı iletildi.` });
                
                if (offerId) removePendingOffer(offerId);
                return;
              }

              // YANIT 3: ANKET YÖNLENDİRMESİ (/anket)
              if (command === '/anket' || command === '!anket') {
                const anketMesaj = `Merhaba,\n\nLaptop Express hizmet sürecini tamamladığınız için teşekkür ederiz! 🌟\n\nHizmet kalitemizi değerlendirmek ve deneyiminizi paylaşmak için aşağıdaki linkten kısa değerlendirmemize katılabilirsiniz:\n\n👉 https://laptopexpress.tr/degerlendirmeler`;
                await sock.sendMessage(targetJid, { text: anketMesaj });
                await sock.sendMessage(fromJid, { text: `⭐ Müşteriye (${cleanPhone}) değerlendirme/anket linki gönderildi.` });
                
                if (offerId) removePendingOffer(offerId);
                return;
              }

              // YANIT 4: FİYAT TEKLİFİ VERME (Sadece rakam yazıldığında)
              const offerPrice = command;
              if (offerPrice && !isNaN(offerPrice)) {
                const customerMessage = `Merhaba,\n\nLaptop Express üzerinden ilettiğiniz cihaz teklif talebiniz incelenmiştir.\n\n💰 *Firmamızın Değerleme Teklifi:* *${offerPrice} TL*\n\nTeklifi onaylıyorsanız mağazamızda veya adresinizde nakit ödeme işleminizi anında tamamlayabiliriz.`;
                
                await sock.sendMessage(targetJid, { text: customerMessage });

                const now = new Date();
                const dateStr = now.toLocaleDateString('tr-TR') + ' ' + now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                saveCompletedOffer({ name: customerName, phone: cleanPhone, price: offerPrice, date: dateStr });

                await sock.sendMessage(fromJid, { text: `✓ *${offerPrice} TL* teklif müşteriye başarıyla iletildi ve kayıt altına alındı.` });

                if (offerId) {
                  updatePendingOffer(offerId, {
                    status: 'OFFER_SENT',
                    offerSentAt: Date.now(),
                    phone: cleanPhone
                  });
                }
              }
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
    if (!offer || !offer.telefon) return res.status(400).json({ error: 'Eksik teklif verisi' });

    const offerId = offer.id || `TEK-${Date.now().toString().slice(-6)}`;
    const adminNotification = `📩 *YENİ TEKLİF TALEBİ (#${offerId})*\n\n` +
      `👤 *Müşteri:* ${offer.musteri_adi || 'Belirtilmedi'}\n` +
      `📞 *Telefon:* ${offer.telefon}\n` +
      `💻 *İşlemci:* ${offer.islemci || '-'}\n` +
      `🎮 *Ekran Kartı:* ${offer.ekran_karti || '-'}\n` +
      `⚡ *RAM / SSD:* ${offer.ram || '-'} / ${offer.ssd || '-'}\n` +
      `✨ *Kozmetik / Durum:* ${offer.kozmetik || '-'} / ${offer.kullanim_durumu || '-'}\n\n` +
      `💡 *İşlem Yapmak İçin Bu Mesajı "Yanıtla (Reply)" Yaparak Şunları Yazın:*\n` +
      `• *Rakam:* Fiyat teklifi iletir (Örn: 18500)\n` +
      `• */eksik* : Cihaz ve telefon fotoğrafı ister\n` +
      `• */red* : Kibarca reddeder\n` +
      `• */anket* : Değerlendirme linki gönderir`;

    if (sock && connectionStatus === 'CONNECTED') {
      const groupJid = await findGroupJidByName(TARGET_GROUP_NAME);

      if (groupJid) {
        try {
          await sock.sendMessage(groupJid, { text: adminNotification });

          savePendingOffer({
            id: offerId,
            phone: offer.telefon.trim().replace(/\D/g, ''),
            createdAt: Date.now(),
            status: 'WAITING_RESPONSE',
            timeoutWarned: false,
            followUpSent: false
          });

          return res.json({ success: true, message: 'Gruba bildirim gönderildi.' });
        } catch (sendErr) {
          return res.status(500).json({ error: 'Gruba mesaj atılamadı.' });
        }
      } else {
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
  startBackgroundJobs();
  setTimeout(() => connectToWhatsApp(), 2000);
});
