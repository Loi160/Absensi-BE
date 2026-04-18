import express from "express";
import cors from "cors";
import "dotenv/config";
import cron from "node-cron";
import { supabase } from "./config/supabase.js";

// Inisialisasi aplikasi Express dan middleware global
const app = express();
app.use(cors());
app.use(express.json());

// Mengambil waktu saat ini dan dikonversi secara manual ke Zona Waktu Indonesia Barat (WIB)
const getIndonesianTime = (offsetDays = 0) => {
  const currentDate = new Date();
  // Kalkulasi manual untuk mendapatkan timestamp UTC+7
  const utcTimestamp = currentDate.getTime() + currentDate.getTimezoneOffset() * 60000;
  const wibTime = new Date(utcTimestamp + 3600000 * 7);

  // Fitur offset untuk mencari tanggal di masa lalu atau masa depan (misal: H-6 atau H+1)
  if (offsetDays !== 0) {
    wibTime.setDate(wibTime.getDate() + offsetDays);
  }

  const year = wibTime.getFullYear();
  const month = String(wibTime.getMonth() + 1).padStart(2, "0");
  const day = String(wibTime.getDate()).padStart(2, "0");

  return {
    dateString: `${year}-${month}-${day}`, // Format YYYY-MM-DD
    dayOfWeek: wibTime.getDay(), // 0 = Minggu, 6 = Sabtu
    dateObject: wibTime,
  };
};

// Menghitung selisih waktu dalam satuan menit (digunakan untuk keterlambatan & lembur)
const calculateMinutesDifference = (startTime, endTime) => {
  if (!startTime || !endTime) return 0;
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  return endHour * 60 + endMinute - (startHour * 60 + startMinute);
};

// Memastikan data input cabang memiliki tipe data yang benar sebelum masuk ke database
const formatBranchPayload = (body) => {
  const payload = { ...body };
  const numericFields = ["keterlambatan", "parent_id", "radius_toleransi"];
  const timeFields = [
    "jam_masuk_weekday", "jam_keluar_weekday", "jam_masuk_weekend",
    "jam_keluar_weekend", "jam_mulai_lembur", "jam_selesai_lembur",
  ];

  // Konversi string angka menjadi integer
  numericFields.forEach((field) => {
    if (payload[field]) payload[field] = parseInt(payload[field], 10);
  });

  // Standarisasi format waktu dari HH:mm menjadi HH:mm:ss untuk kompatibilitas Supabase
  timeFields.forEach((field) => {
    if (payload[field] && payload[field].length === 5) {
      payload[field] = `${payload[field]}:00`;
    }
  });

  return payload;
};

// Membersihkan data user/karyawan dari atribut yang tidak diperlukan database
const sanitizeUserPayload = (body) => {
  const payload = { ...body };
  delete payload.id;
  delete payload.cabang;

  // Normalisasi string kosong menjadi null agar tidak error saat insert ke database
  payload.tanggal_masuk = payload.tanggal_masuk || null;
  payload.tanggal_lahir = payload.tanggal_lahir || null;

  if (payload.cabang_id) {
    const parsedId = parseInt(payload.cabang_id, 10);
    payload.cabang_id = isNaN(parsedId) ? null : parsedId;
  } else {
    payload.cabang_id = null;
  }

  return payload;
};

app.get("/", (req, res) => {
  res.send("API Absensi Amaga Corp jalan 🚀");
});

// Proses login karyawan berdasarkan NIK dan validasi status aktif
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const { data: user, error } = await supabase
      .from("users")
      .select("*, cabang(*)")
      .eq("nik", username)
      .single();

    if (error || !user) {
      return res.status(401).json({ message: "Username tidak ditemukan" });
    }

    if (user.password !== password) {
      return res.status(401).json({ message: "Password salah" });
    }

    if (user.status === "Nonaktif") {
      return res.status(403).json({ message: "Akun Anda telah dinonaktifkan. Hubungi HRD." });
    }

    // Jika yang login adalah Manager, ambil daftar nama sub-cabang yang berada di bawahnya
    let subBranchNames = [];
    if (user.role === "managerCabang" && user.cabang_id) {
      const { data: subBranches } = await supabase
        .from("cabang")
        .select("nama")
        .eq("parent_id", user.cabang_id);
      if (subBranches) subBranchNames = subBranches.map((branch) => branch.nama);
    }

    res.status(200).json({
      message: "Login Berhasil",
      user: {
        id: user.id,
        nama: user.nama,
        role: user.role,
        nik: user.nik,
        foto_karyawan: user.foto_karyawan,
        cabang_id: user.cabang_id,
        cabangUtama: user.cabang?.nama || "Pusat",
        titik_koordinat: user.cabang?.titik_koordinat || null,
        radius_toleransi: user.cabang?.radius_toleransi || 20,
        subCabang: subBranchNames,
        jabatan: user.jabatan,
        divisi: user.divisi,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
});

// Mengambil seluruh daftar cabang
app.get("/api/cabang", async (req, res) => {
  const { data } = await supabase
    .from("cabang")
    .select("*")
    .order("id", { ascending: true });
  res.status(200).json(data || []);
});

// Menambahkan cabang baru
app.post("/api/cabang", async (req, res) => {
  try {
    const payload = formatBranchPayload(req.body);
    const { error } = await supabase.from("cabang").insert([payload]);
    if (error) return res.status(400).json({ message: "Gagal menambah cabang", detail: error.message });
    res.status(201).json({ message: "Cabang berhasil ditambahkan" });
  } catch (err) {
    res.status(500).json({ message: "Gagal menambah cabang", error: err.message });
  }
});

// Memperbarui informasi cabang yang sudah ada
app.put("/api/cabang/:id", async (req, res) => {
  try {
    const payload = formatBranchPayload(req.body);
    const { error } = await supabase.from("cabang").update(payload).eq("id", req.params.id);
    if (error) throw error;
    res.status(200).json({ message: "Data cabang berhasil diubah" });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengubah cabang", error: err.message });
  }
});

// Mengaktifkan atau menonaktifkan status cabang
app.put("/api/cabang/:id/status", async (req, res) => {
  try {
    const { is_active } = req.body;
    const { error } = await supabase.from("cabang").update({ is_active }).eq("id", req.params.id);
    if (error) throw error;
    res.status(200).json({ message: "Status cabang berhasil diubah" });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengubah status cabang", error: err.message });
  }
});

// Mengambil data seluruh karyawan beserta informasi cabangnya
app.get("/api/karyawan", async (req, res) => {
  const { data } = await supabase.from("users").select("*, cabang(nama)").order("nama", { ascending: true });
  res.status(200).json(data || []);
});

// Menambah data karyawan baru
app.post("/api/karyawan", async (req, res) => {
  try {
    const payload = sanitizeUserPayload(req.body);
    const { error } = await supabase.from("users").insert([payload]);
    if (error) return res.status(400).json({ message: "Gagal menambah data", detail: error.message });
    res.status(201).json({ message: "Karyawan berhasil ditambahkan" });
  } catch (err) {
    res.status(500).json({ message: "Gagal menambah karyawan", detail: err.message });
  }
});

// Memperbarui data profil karyawan
app.put("/api/karyawan/:id", async (req, res) => {
  try {
    const payload = sanitizeUserPayload(req.body);
    const { error } = await supabase.from("users").update(payload).eq("id", req.params.id);
    if (error) return res.status(400).json({ message: "Gagal mengubah data", detail: error.message });
    res.status(200).json({ message: "Data berhasil diubah" });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengubah data", detail: err.message });
  }
});

// Mengubah status aktif/nonaktif karyawan
app.put("/api/karyawan/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    const { error } = await supabase.from("users").update({ status }).eq("id", req.params.id);
    if (error) throw error;
    res.status(200).json({ message: `Status berhasil diubah menjadi ${status}` });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengubah status karyawan" });
  }
});

// Menangani permintaan absensi harian (Masuk, Istirahat, Pulang)
app.post("/api/absensi", async (req, res) => {
  const { user_id, tipe_absen, waktu, foto, waktu_istirahat_mulai, waktu_istirahat_selesai } = req.body;
  const { dateString: today, dayOfWeek } = getIndonesianTime();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  try {
    const { data: user } = await supabase.from("users").select("cabang_id").eq("id", user_id).single();
    const { data: branch } = await supabase.from("cabang").select("*").eq("id", user.cabang_id).single();
    const { data: existingAttendance } = await supabase.from("absensi").select("*").eq("user_id", user_id).eq("tanggal", today).single();

    // Logika Absen Masuk: Cek keterlambatan berdasarkan jadwal cabang (Weekday/Weekend)
    if (tipe_absen === "Masuk") {
      if (existingAttendance?.waktu_masuk) {
        return res.status(400).json({ message: "Anda sudah melakukan Absen Masuk hari ini." });
      }

      let minutesLate = 0;
      if (branch) {
        const targetTime = isWeekend ? branch.jam_masuk_weekend : branch.jam_masuk_weekday;
        const tolerance = branch.keterlambatan || 0;
        const diff = calculateMinutesDifference(targetTime, waktu);
        if (diff > tolerance) minutesLate = diff;
      }

      const { error } = await supabase.from("absensi").insert([{
        user_id, tanggal: today, waktu_masuk: waktu, foto_masuk: foto, status_kehadiran: "Hadir", menit_terlambat: minutesLate,
      }]);
      if (error) throw error;

    // Logika Istirahat: Menyimpan jam mulai dan jam selesai istirahat
    } else if (tipe_absen === "Istirahat") {
      if (!existingAttendance) return res.status(400).json({ message: "Anda belum Absen Masuk hari ini." });
      if (existingAttendance.waktu_istirahat_mulai) return res.status(400).json({ message: "Jadwal istirahat sudah diatur sebelumnya." });

      const { error } = await supabase.from("absensi").update({
        waktu_istirahat_mulai, waktu_istirahat_selesai,
      }).eq("id", existingAttendance.id);
      if (error) throw error;

    // Logika Absen Pulang: Kalkulasi lembur otomatis
    } else if (tipe_absen === "Pulang") {
      if (!existingAttendance?.waktu_masuk) return res.status(400).json({ message: "Anda belum Absen Masuk hari ini." });
      if (existingAttendance.waktu_pulang) return res.status(400).json({ message: "Anda sudah Absen Pulang hari ini." });

      let overtimeMinutes = 0;
      if (branch) {
        // Bonus lembur 3 jam jika karyawan tidak mengambil waktu istirahat
        if (!existingAttendance.waktu_istirahat_mulai) overtimeMinutes += 180;

        const overtimeStart = branch.jam_mulai_lembur || "18:00:00";
        const overtimeEnd = branch.jam_selesai_lembur || "20:00:00";
        const overtimeDiff = calculateMinutesDifference(overtimeStart, waktu);

        // Batasi menit lembur agar tidak melebihi jam selesai lembur yang ditetapkan cabang
        if (overtimeDiff > 0) {
          const maxOvertime = calculateMinutesDifference(overtimeStart, overtimeEnd);
          overtimeMinutes += (overtimeDiff >= maxOvertime) ? maxOvertime : overtimeDiff;
        }
      }

      const { error } = await supabase.from("absensi").update({
        waktu_pulang: waktu, foto_pulang: foto, menit_lembur: overtimeMinutes,
      }).eq("id", existingAttendance.id);
      if (error) throw error;
    }

    res.status(200).json({ message: `Absen ${tipe_absen} berhasil dicatat!` });
  } catch (error) {
    res.status(500).json({ message: "Gagal memproses absensi.", detail: error.message });
  }
});

// Fitur bagi HRD untuk menginput atau mengoreksi absen karyawan secara manual
app.post("/api/absensi/manual", async (req, res) => {
  const { user_id, tanggal, waktu_masuk, waktu_pulang, keterangan } = req.body;
  try {
    let minutesLate = 0;
    let overtimeMinutes = 0;

    const { data: user } = await supabase.from("users").select("cabang_id").eq("id", user_id).single();
    const { data: branch } = await supabase.from("cabang").select("*").eq("id", user?.cabang_id).single();

    // Kalkulasi ulang keterlambatan pada input manual
    if (branch && waktu_masuk) {
      const date = new Date(tanggal);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      const targetTime = isWeekend ? branch.jam_masuk_weekend : branch.jam_masuk_weekday;
      const diff = calculateMinutesDifference(targetTime, waktu_masuk);
      if (diff > (branch.keterlambatan || 0)) minutesLate = diff;
    }

    // Kalkulasi ulang lembur pada input manual
    if (branch && waktu_pulang) {
      const overtimeStart = branch.jam_mulai_lembur || "18:00:00";
      const overtimeEnd = branch.jam_selesai_lembur || "20:00:00";
      const overtimeDiff = calculateMinutesDifference(overtimeStart, waktu_pulang);
      if (overtimeDiff > 0) {
        const maxOvertime = calculateMinutesDifference(overtimeStart, overtimeEnd);
        overtimeMinutes = (overtimeDiff >= maxOvertime) ? maxOvertime : overtimeDiff;
      }
    }

    const { data: existingAttendance } = await supabase.from("absensi").select("*").eq("user_id", user_id).eq("tanggal", tanggal).single();

    // Jika sudah ada data di tanggal tersebut, lakukan UPDATE, jika tidak lakukan INSERT
    if (existingAttendance) {
      await supabase.from("absensi").update({
        waktu_masuk: waktu_masuk || existingAttendance.waktu_masuk,
        waktu_pulang: waktu_pulang || existingAttendance.waktu_pulang,
        is_manual_masuk: true,
        keterangan_manual: keterangan,
        menit_terlambat: waktu_masuk ? minutesLate : existingAttendance.menit_terlambat,
        menit_lembur: waktu_pulang ? overtimeMinutes : existingAttendance.menit_lembur,
      }).eq("id", existingAttendance.id);
    } else {
      await supabase.from("absensi").insert([{
        user_id, tanggal, waktu_masuk, waktu_pulang, status_kehadiran: "Hadir", is_manual_masuk: true, keterangan_manual: keterangan, menit_terlambat: minutesLate, menit_lembur: overtimeMinutes
      }]);
    }
    res.status(200).json({ message: "Absensi manual berhasil disimpan" });
  } catch (err) {
    res.status(500).json({ message: "Gagal menyimpan absensi manual" });
  }
});

// Mengambil riwayat absensi dan izin, serta mendeteksi hari 'ALPHA' secara otomatis
app.get("/api/riwayat/:user_id", async (req, res) => {
  const userId = req.params.user_id;

  try {
    const { data: user } = await supabase.from("users").select("*, cabang(nama)").eq("id", userId).single();
    const { data: attendanceList } = await supabase.from("absensi").select("*").eq("user_id", userId).order("tanggal", { ascending: false });
    const { data: permissionList } = await supabase.from("perizinan").select("*").eq("user_id", userId).order("created_at", { ascending: false });

    const { dateObject: todayObj, dateString: todayStr } = getIndonesianTime();
    const startDate = new Date(todayObj);
    startDate.setDate(todayObj.getDate() - 30); // Analisis kehadiran 30 hari terakhir
    
    let syntheticAlpha = [];
    const isPusat = user?.cabang?.nama?.toLowerCase().includes("amaga") || user?.cabang?.nama?.toLowerCase().includes("pusat") || !user?.cabang_id;

    // Loop pengecekan harian untuk menemukan tanggal yang tidak ada absen maupun izin
    for (let i = 0; i <= 30; i++) {
      let currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + i);
      let dateKey = currentDate.toISOString().split("T")[0];
      let dayOfWeek = currentDate.getDay();

      if (dateKey >= todayStr) break; 
      if (isPusat && dayOfWeek === 0) continue; // Skip hari Minggu untuk cabang pusat

      const hasAttendance = attendanceList.some((record) => record.tanggal === dateKey);
      const hasPermission = permissionList.some((perm) => perm.status_approval === 'Disetujui' && dateKey >= perm.tanggal_mulai && dateKey <= perm.tanggal_selesai);

      // Jika data kosong, masukkan ke array sebagai status ALPHA
      if (!hasAttendance && !hasPermission) {
        syntheticAlpha.push({
          id: `alpha_${dateKey}`,
          user_id: userId,
          tanggal: dateKey,
          waktu_masuk: null,
          waktu_pulang: null,
          status_kehadiran: "ALPHA",
          is_alpha: true 
        });
      }
    }

    const mergedAttendance = [...(attendanceList || []), ...syntheticAlpha];
    res.status(200).json({ absensi: mergedAttendance, perizinan: permissionList || [] });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil riwayat" });
  }
});

// Mengajukan izin atau cuti baru
app.post("/api/perizinan", async (req, res) => {
  await supabase.from("perizinan").insert([req.body]);
  res.status(201).json({ message: "Pengajuan berhasil dikirim." });
});

// Mengambil seluruh daftar perizinan untuk HRD
app.get("/api/perizinan/all", async (req, res) => {
  const { data } = await supabase.from("perizinan").select("*, users (*, cabang(nama))").order("created_at", { ascending: false });
  res.status(200).json(data || []);
});

// Update status persetujuan izin (Disetujui/Ditolak)
app.put("/api/perizinan/:id/status", async (req, res) => {
  await supabase.from("perizinan").update({ status_approval: req.body.status_approval }).eq("id", req.params.id);
  res.status(200).json({ message: "Berhasil" });
});

// Mengambil perizinan khusus untuk karyawan di cabang tertentu (Role: Manager Cabang)
app.get("/api/manager/perizinan/:cabang_id", async (req, res) => {
  const { data } = await supabase.from("perizinan").select("*, users!inner(*, cabang(nama))").eq("users.cabang_id", req.params.cabang_id).order("created_at", { ascending: false });
  res.status(200).json(data || []);
});

// Menghasilkan rekapitulasi laporan bulanan (Periode tanggal 26 ke 25)
app.get("/api/laporan", async (req, res) => {
  const { role, cabang_id, start_date, end_date } = req.query;
  const { dateObject: todayObj, dateString: todayStr } = getIndonesianTime();
  
  let startStr = start_date;
  let endStr = end_date;

  // Jika rentang tanggal tidak diinput, gunakan periode default cut-off (26 bln lalu s/d 25 bln ini)
  if (!startStr || !endStr) {
    const year = todayObj.getFullYear();
    const month = todayObj.getMonth();
    const date = todayObj.getDate();
    let start, end;

    if (date <= 25) {
      start = new Date(year, month - 1, 26);
      end = new Date(year, month, 25);
    } else {
      start = new Date(year, month, 26);
      end = new Date(year, month + 1, 25);
    }

    const format = (dt) => {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };

    if (!startStr) startStr = format(start);
    if (!endStr) endStr = format(end);
  }

  // List seluruh tanggal dalam rentang periode yang dipilih
  let dateList = [];
  let runner = new Date(startStr);
  let stopDate = new Date(endStr);
  if (stopDate > todayObj) stopDate = todayObj;

  while (runner <= stopDate) {
    dateList.push({ dateStr: runner.toISOString().split("T")[0], dayOfWeek: runner.getDay() });
    runner.setDate(runner.getDate() + 1);
  }

  try {
    let userQuery = supabase.from("users").select("id, nama, nik, cabang_id, cabang(*)");
    if (role === "managerCabang" && cabang_id) userQuery = userQuery.eq("cabang_id", cabang_id);

    const { data: users } = await userQuery;
    const { data: attendanceData } = await supabase.from("absensi").select("*");
    const { data: permissionData } = await supabase.from("perizinan").select("*").eq("status_approval", "Disetujui");

    // Agregasi data absensi, izin, dan alpha untuk setiap karyawan
    const report = users.map((user) => {
      const isPusat = user.cabang?.nama?.toLowerCase().includes("amaga") || user.cabang?.nama?.toLowerCase().includes("pusat") || !user.cabang_id;
      const userAttendance = attendanceData.filter((a) => a.user_id === user.id && a.tanggal >= startStr && a.tanggal <= endStr);
      const userPermissions = permissionData.filter((p) => p.user_id === user.id && p.tanggal_selesai >= startStr && p.tanggal_mulai <= endStr);

      // Hitung ulang keterlambatan jika belum tercatat di DB
      userAttendance.forEach((record) => {
        if (!record.menit_terlambat && user.cabang && record.waktu_masuk) {
          const d = new Date(record.tanggal);
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          const target = isWeekend ? user.cabang.jam_masuk_weekend : user.cabang.jam_masuk_weekday;
          const tolerance = user.cabang.keterlambatan || 0;
          const diff = calculateMinutesDifference(target, record.waktu_masuk);
          if (diff > tolerance) record.menit_terlambat = diff;
        }
      });

      const lateCount = userAttendance.filter((a) => a.menit_terlambat > 0).length;
      const totalOvertimeMinutes = userAttendance.reduce((sum, a) => sum + (a.menit_lembur || 0), 0);
      const totalOvertimeHours = Math.floor(totalOvertimeMinutes / 60);

      let alphaCount = 0;
      let alphaDates = []; 

      // Deteksi hari ALPHA dalam periode laporan
      dateList.forEach((d) => {
        if (d.dateStr >= todayStr) return;
        if (isPusat && d.dayOfWeek === 0) return; 

        const hasAttendance = userAttendance.some((a) => a.tanggal === d.dateStr);
        const hasPermission = userPermissions.some((p) => d.dateStr >= p.tanggal_mulai && d.dateStr <= p.tanggal_selesai);

        if (!hasAttendance && !hasPermission) {
          alphaCount++;
          alphaDates.push({ tanggal: d.dateStr, keterangan: "Tanpa Keterangan" });
        }
      });

      return {
        id: user.id,
        nama: user.nama,
        nik: user.nik,
        cabang: user.cabang?.nama || "-",
        hadirApp: userAttendance.filter((a) => !a.is_manual_masuk).length.toString(),
        hadirManual: userAttendance.filter((a) => a.is_manual_masuk).length.toString(),
        izin: userPermissions.filter((p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit").length.toString(),
        sakit: userPermissions.filter((p) => p.kategori === "Izin" && p.jenis_izin === "Sakit").length.toString(),
        cuti: userPermissions.filter((p) => p.kategori === "Cuti").length.toString(),
        terlambat: lateCount.toString(),
        fimtk: userPermissions.filter((p) => p.kategori === "FIMTK").length.toString(),
        lembur: `${totalOvertimeHours} Jam`,
        alpha: alphaCount.toString(),
        rawAbsensi: userAttendance,
        rawPerizinan: userPermissions,
        rawAlpha: alphaDates 
      };
    });
    res.status(200).json(report);
  } catch (err) {
    res.status(500).json({ message: "Gagal" });
  }
});

// Mengambil data statistik untuk grafik dan ringkasan di halaman dashboard admin/manager
app.get("/api/dashboard/stats", async (req, res) => {
  const { role, cabang_id, sub_cabang } = req.query; 
  try {
    let userQuery = supabase.from("users").select("id, cabang(nama)");
    
    // Filter data berdasarkan role dan filter cabang yang dipilih di UI
    if (role === "managerCabang" && cabang_id) {
      if (sub_cabang && !["Semua Sub-Cabang", "Semua Cabang"].includes(sub_cabang)) {
        userQuery = userQuery.eq("cabang.nama", sub_cabang);
      } else {
        userQuery = userQuery.eq("cabang_id", cabang_id);
      }
    } else if (role === "hrd" && sub_cabang !== "Semua Cabang") {
       userQuery = userQuery.eq("cabang.nama", sub_cabang);
    }
    
    const { data: allUsers } = await userQuery;
    const users = sub_cabang && !["Semua Cabang", "Semua Sub-Cabang"].includes(sub_cabang) 
      ? allUsers.filter(u => u.cabang?.nama === sub_cabang) 
      : allUsers;

    const userIds = users.map((u) => u.id);

    if (userIds.length === 0) {
      return res.status(200).json({
        totals: { hadir: 0, sakit: 0, izin: 0, cuti: 0, terlambat: 0, alpha: 0 },
        chart: { hadir: Array(7).fill(0), sakit: Array(7).fill(0), izin: Array(7).fill(0), cuti: Array(7).fill(0), terlambat: Array(7).fill(0), alpha: Array(7).fill(0) },
      });
    }

    const { dateString: todayStr } = getIndonesianTime();
    const { dateString: sixDaysAgoStr, dateObject: spanDaysAgo } = getIndonesianTime(-6);

    const { data: attendanceRecords } = await supabase.from("absensi").select("*").in("user_id", userIds).gte("tanggal", sixDaysAgoStr);
    const { data: approvedPermissions } = await supabase.from("perizinan").select("*").in("user_id", userIds).eq("status_approval", "Disetujui");

    const chart = { hadir: Array(7).fill(0), sakit: Array(7).fill(0), izin: Array(7).fill(0), cuti: Array(7).fill(0), terlambat: Array(7).fill(0), alpha: Array(7).fill(0) };
    let alphaCounter = 0;

    // Menghitung statistik harian untuk ditampilkan pada grafik (7 hari terakhir)
    for (let i = 0; i <= 6; i++) {
      let runner = new Date(spanDaysAgo);
      runner.setDate(runner.getDate() + i);
      let dateKey = runner.toISOString().split("T")[0];
      let dayIndex = runner.getDay();
      const chartIndex = dayIndex === 0 ? 6 : dayIndex - 1; // Ubah index agar Senin=0, Minggu=6

      if (dateKey >= todayStr) break;

      users.forEach((user) => {
        const isPusat = user.cabang?.nama?.toLowerCase().includes("amaga") || user.cabang?.nama?.toLowerCase().includes("pusat");
        if (isPusat && dayIndex === 0) return;

        const hasAttendance = attendanceRecords.some((a) => a.user_id === user.id && a.tanggal === dateKey);
        const hasPermission = approvedPermissions.some((p) => p.user_id === user.id && dateKey >= p.tanggal_mulai && dateKey <= p.tanggal_selesai);

        if (!hasAttendance && !hasPermission) {
          alphaCounter++;
          chart.alpha[chartIndex] += 1;
        }
      });
    }

    attendanceRecords.forEach((record) => {
      const user = users.find(u => u.id === record.user_id);
      if (!record.menit_terlambat && user?.cabang && record.waktu_masuk) {
          const d = new Date(record.tanggal);
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          const target = isWeekend ? user.cabang.jam_masuk_weekend : user.cabang.jam_masuk_weekday;
          const diff = calculateMinutesDifference(target, record.waktu_masuk);
          if (diff > (user.cabang.keterlambatan || 0)) record.menit_terlambat = diff;
      }

      const dayIdx = new Date(record.tanggal).getDay();
      const chartIdx = dayIdx === 0 ? 6 : dayIdx - 1;
      chart.hadir[chartIdx] += 1;
      if (record.menit_terlambat > 0) chart.terlambat[chartIdx] += 1;
    });

    const totals = {
      hadir: attendanceRecords.length,
      sakit: approvedPermissions.filter((p) => p.kategori === "Izin" && p.jenis_izin === "Sakit").length,
      izin: approvedPermissions.filter((p) => p.kategori === "Izin" && p.jenis_izin !== "Sakit").length,
      cuti: approvedPermissions.filter((p) => p.kategori === "Cuti").length,
      terlambat: attendanceRecords.filter((a) => a.menit_terlambat > 0).length,
      alpha: alphaCounter,
    };

    res.status(200).json({ totals, chart });
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil statistik" });
  }
});

// Menghapus foto absensi yang sudah lebih dari 30 hari untuk menghemat ruang penyimpanan
app.delete("/api/cleanup-fotos", async (req, res) => {
  try {
    const { dateObject: todayObj } = getIndonesianTime();
    const cutoffDate = new Date(todayObj);
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    // Ambil data absensi lama yang memiliki URL foto
    const { data: staleAttendance, error: fetchErr } = await supabase
      .from("absensi")
      .select("id, foto_masuk, foto_pulang")
      .lt("tanggal", cutoffStr)
      .or('foto_masuk.not.is.null,foto_pulang.not.is.null');

    if (fetchErr) throw fetchErr;
    if (!staleAttendance?.length) {
      return res.status(200).json({ message: "Tidak ada foto usang yang perlu dihapus." });
    }

    // List seluruh nama file yang akan dihapus dari Storage
    let filesToDelete = [];
    staleAttendance.forEach(record => {
      [record.foto_masuk, record.foto_pulang].forEach(url => {
        if (url && !url.includes("Telah Dihapus")) {
          const fileName = url.split('/').pop();
          filesToDelete.push(fileName);
        }
      });
    });

    // Proses penghapusan fisik file di Supabase Storage
    if (filesToDelete.length > 0) {
      const { error: rmErr } = await supabase.storage.from("foto_absensi").remove(filesToDelete);
      if (rmErr) console.error("Gagal hapus fisik foto:", rmErr);
    }

    // Update database agar kolom foto berisi keterangan bahwa foto telah dihapus otomatis
    for (const record of staleAttendance) {
      const updatePayload = {};
      if (record.foto_masuk && !record.foto_masuk.includes("Telah Dihapus")) updatePayload.foto_masuk = "Telah Dihapus Otomatis (Lebih dari 30 Hari)";
      if (record.foto_pulang && !record.foto_pulang.includes("Telah Dihapus")) updatePayload.foto_pulang = "Telah Dihapus Otomatis (Lebih dari 30 Hari)";
      
      if (Object.keys(updatePayload).length > 0) {
         await supabase.from("absensi").update(updatePayload).eq("id", record.id);
      }
    }

    res.status(200).json({ message: `Berhasil membersihkan foto usang dari ${staleAttendance.length} data absensi.` });
  } catch (err) {
    res.status(500).json({ message: "Gagal membersihkan foto", detail: err.message });
  }
});

// Penjadwalan otomatis (Cron Job) setiap jam 12 malam untuk menjalankan fungsi pembersihan foto
cron.schedule('0 0 * * *', async () => {
  try {
     const apiUrl = process.env.API_URL || 'http://localhost:3000';
     const response = await fetch(`${apiUrl}/api/cleanup-fotos`, { method: 'DELETE' });
     const result = await response.json();
     console.log('Cron Job Success:', result.message);
  } catch (err) {
     console.error('Cron Job Failed:', err);
  }
}, {
  scheduled: true,
  timezone: "Asia/Jakarta"
});

// Menjalankan server pada port yang ditentukan
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});