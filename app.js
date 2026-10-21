const CAR_FACTOR = { standard: 1, confort: 1.25, van: 1.45 };
const STORAGE_KEY = "taxiette-rides-v2";
const TUNIS = [36.8065, 10.1815];
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OSRM = "https://router.project-osrm.org/route/v1/driving";
const OVERPASS = "https://overpass-api.de/api/interpreter";

const els = {
  from: document.querySelector("#from"),
  to: document.querySelector("#to"),
  fromSuggest: document.querySelector("#from-suggest"),
  toSuggest: document.querySelector("#to-suggest"),
  date: document.querySelector("#date"),
  time: document.querySelector("#time"),
  car: document.querySelector("#car"),
  estimate: document.querySelector("#estimate"),
  estimateValue: document.querySelector("#estimate-value"),
  estimateLabel: document.querySelector("#estimate-label"),
  form: document.querySelector("#booking-form"),
  passengerRides: document.querySelector("#passenger-rides"),
  driverRides: document.querySelector("#driver-rides"),
  rideCount: document.querySelector("#ride-count"),
  passengerView: document.querySelector("#passenger-view"),
  driverView: document.querySelector("#driver-view"),
  driverName: document.querySelector("#driver-name"),
  placeDims: document.querySelector("#place-dims"),
  nearby: document.querySelector("#nearby"),
  nearbyList: document.querySelector("#nearby-list"),
  mapHint: document.querySelector("#map-hint"),
};

const state = {
  pick: "from",
  from: null,
  to: null,
  km: 0,
  roadKm: 0,
};

let map;
let fromMarker;
let toMarker;
let fromBox;
let toBox;
let routeLine;
let searchTimer;

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function haversineKm(a, b) {
  const toRad = (n) => (n * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function bboxMeters(bbox) {
  if (!bbox || bbox.length < 4) return null;
  const south = Number(bbox[0]);
  const north = Number(bbox[1]);
  const west = Number(bbox[2]);
  const east = Number(bbox[3]);
  const height = haversineKm({ lat: south, lon: west }, { lat: north, lon: west }) * 1000;
  const width = haversineKm({ lat: south, lon: west }, { lat: south, lon: east }) * 1000;
  return { south, north, west, east, width, height };
}

function estimatePrice(km, car) {
  const distance = Math.max(km, 1.2);
  const base = 3.5 + distance * 1.15;
  return Math.round(base * (CAR_FACTOR[car] || 1) * 2) / 2;
}

function loadRides() {
  try {
    const rides = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    return rides.map((ride) => {
      if (ride.status === "accept") ride.status = "accepted";
      return ride;
    });
  } catch {
    return [];
  }
}

function saveRides(rides) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rides));
}

function statusLabel(status) {
  return {
    pending: "في الانتظار",
    accepted: "مقبول",
    enroute: "في الطريق",
    done: "تمت",
    cancelled: "ملغاة",
  }[status] || status;
}

function carLabel(car) {
  return { standard: "عادي", confort: "كونفور", van: "فان / عائلي" }[car] || car;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function placeTitle(place) {
  return place.namedetails?.name || place.display_name?.split(",")[0] || place.name || "مكان";
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView(TUNIS, 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  map.on("click", async (event) => {
    const lat = event.latlng.lat;
    const lon = event.latlng.lng;
    els.mapHint.textContent = "قاعد نبحث على المكان في OpenStreetMap...";
    const place = await reverseGeocode(lat, lon);
    if (!place) {
      els.mapHint.textContent = "ما لقيناش اسم للمكان، أما النقطة تحطّت.";
      await setPlace(state.pick, {
        lat,
        lon,
        display_name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        type: "point",
        class: "clicked",
        boundingbox: [lat - 0.001, lat + 0.001, lon - 0.001, lon + 0.001],
      });
      return;
    }
    await setPlace(state.pick, place);
  });

  setTimeout(() => map.invalidateSize(), 200);
}

async function nominatimSearch(query) {
  const url = new URL(`${NOMINATIM}/search`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("limit", "7");
  url.searchParams.set("countrycodes", "tn");
  url.searchParams.set("accept-language", "ar,fr");
  url.searchParams.set("q", query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return [];
  return res.json();
}

async function reverseGeocode(lat, lon) {
  const url = new URL(`${NOMINATIM}/reverse`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("zoom", "18");
  url.searchParams.set("accept-language", "ar,fr");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return {
    ...data,
    lat: Number(data.lat),
    lon: Number(data.lon),
  };
}

async function fetchNearby(place) {
  const query = `
    [out:json][timeout:15];
    (
      nwr(around:450,${place.lat},${place.lon})[name][amenity];
      nwr(around:450,${place.lat},${place.lon})[name][shop];
      nwr(around:450,${place.lat},${place.lon})[name][tourism];
    );
    out center 15;
  `;
  const res = await fetch(OVERPASS, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.elements || [])
    .map((el) => ({
      id: el.id,
      name: el.tags?.name,
      kind: el.tags?.amenity || el.tags?.shop || el.tags?.tourism || el.type,
      lat: el.lat || el.center?.lat,
      lon: el.lon || el.center?.lon,
    }))
    .filter((el) => el.name && el.lat && el.lon)
    .slice(0, 8);
}

async function fetchRoute(from, to) {
  const url = `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data.routes?.[0] || null;
}

function drawBox(kind, place) {
  const dims = bboxMeters(place.boundingbox);
  if (kind === "from" && fromBox) {
    fromBox.remove();
    fromBox = null;
  }
  if (kind === "to" && toBox) {
    toBox.remove();
    toBox = null;
  }
  if (!dims) return;
  const layer = L.rectangle(
    [
      [dims.south, dims.west],
      [dims.north, dims.east],
    ],
    {
      color: kind === "from" ? "#f5c518" : "#6ea8ff",
      weight: 1,
      fillOpacity: 0.12,
    }
  ).addTo(map);
  if (kind === "from") fromBox = layer;
  else toBox = layer;
}

function upsertMarker(kind, place) {
  const latlng = [Number(place.lat), Number(place.lon)];
  const color = kind === "from" ? "#f5c518" : "#6ea8ff";
  const icon = L.divIcon({
    className: "",
    html: `<div style="background:${color};color:#111;border-radius:999px;padding:4px 8px;font-weight:800;font-size:12px;box-shadow:0 2px 8px #0008">${kind === "from" ? "أ" : "و"}</div>`,
    iconSize: [28, 24],
    iconAnchor: [14, 12],
  });
  if (kind === "from") {
    if (fromMarker) fromMarker.setLatLng(latlng);
    else fromMarker = L.marker(latlng, { icon, title: "الانطلاق" }).addTo(map);
  } else {
    if (toMarker) toMarker.setLatLng(latlng);
    else toMarker = L.marker(latlng, { icon, title: "الوجهة" }).addTo(map);
  }
  drawBox(kind, place);
}

function renderDims() {
  const blocks = ["from", "to"]
    .map((kind) => {
      const place = state[kind];
      if (!place) return "";
      const dims = bboxMeters(place.boundingbox);
      const label = kind === "from" ? "الانطلاق" : "الوجهة";
      const size = dims
        ? `${Math.round(dims.width)}م × ${Math.round(dims.height)}م`
        : "—";
      return `<p><span>${label}: ${escapeHtml(placeTitle(place))}</span><strong>${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)} · ${size} · ${escapeHtml(place.type || place.class || "")}</strong></p>`;
    })
    .join("");
  els.placeDims.hidden = !blocks;
  els.placeDims.innerHTML = blocks;
}

async function updateRouteAndPrice() {
  if (!state.from || !state.to) {
    els.estimate.hidden = true;
    if (routeLine) {
      routeLine.remove();
      routeLine = null;
    }
    return;
  }
  state.km = haversineKm(
    { lat: Number(state.from.lat), lon: Number(state.from.lon) },
    { lat: Number(state.to.lat), lon: Number(state.to.lon) }
  );
  let km = state.km;
  try {
    const route = await fetchRoute(state.from, state.to);
    if (route) {
      state.roadKm = route.distance / 1000;
      km = state.roadKm;
      const latlngs = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      if (routeLine) routeLine.setLatLngs(latlngs);
      else {
        routeLine = L.polyline(latlngs, { color: "#f5c518", weight: 4, opacity: 0.85 }).addTo(map);
      }
      map.fitBounds(routeLine.getBounds(), { padding: [28, 28] });
    }
  } catch {
    state.roadKm = 0;
  }
  const price = estimatePrice(km, els.car.value);
  els.estimate.hidden = false;
  els.estimateLabel.textContent = `المسافة ${km.toFixed(1)} كم · السعر التقريبي`;
  els.estimateValue.textContent = `${price.toFixed(1)} د.ت`;
}

function renderNearby(places) {
  if (!places.length) {
    els.nearby.hidden = true;
    return;
  }
  els.nearby.hidden = false;
  els.nearbyList.innerHTML = places
    .map(
      (place) => `
      <li>
        <button type="button" data-nearby="${place.id}" data-lat="${place.lat}" data-lon="${place.lon}" data-name="${escapeHtml(place.name)}" data-kind="${escapeHtml(place.kind)}">
          ${escapeHtml(place.name)}
          <small>${escapeHtml(place.kind)} · ${haversineKm({ lat: Number(state.from.lat), lon: Number(state.from.lon) }, place).toFixed(2)} كم</small>
        </button>
      </li>`
    )
    .join("");
}

async function setPlace(kind, raw) {
  const place = {
    ...raw,
    lat: Number(raw.lat),
    lon: Number(raw.lon),
  };
  state[kind] = place;
  els[kind].value = place.display_name || placeTitle(place);
  hideSuggest(kind);
  upsertMarker(kind, place);
  map.setView([place.lat, place.lon], Math.max(map.getZoom(), 15));
  renderDims();
  if (kind === "from") {
    els.mapHint.textContent = "توا انقر أو ابحث باش تحدد الوجهة.";
    try {
      renderNearby(await fetchNearby(place));
    } catch {
      els.nearby.hidden = true;
    }
  } else {
    els.mapHint.textContent = "الانطلاق والوجهة ظاهرين على الخريطة مع أبعاد المكان.";
  }
  await updateRouteAndPrice();
}

function hideSuggest(kind) {
  const list = kind === "from" ? els.fromSuggest : els.toSuggest;
  list.hidden = true;
  list.innerHTML = "";
}

function showSuggest(kind, results) {
  const list = kind === "from" ? els.fromSuggest : els.toSuggest;
  if (!results.length) {
    hideSuggest(kind);
    return;
  }
  list.hidden = false;
  list.innerHTML = results
    .map((place, index) => {
      const dims = bboxMeters(place.boundingbox);
      const size = dims ? `${Math.round(dims.width)}×${Math.round(dims.height)}م` : "";
      return `<li><button type="button" data-kind="${kind}" data-index="${index}">${escapeHtml(placeTitle(place))}<small>${escapeHtml(place.display_name)} · ${escapeHtml(place.type || "")} ${size}</small></button></li>`;
    })
    .join("");
  list._results = results;
}

function bindSearch(kind) {
  const input = els[kind];
  input.addEventListener("input", () => {
    const query = input.value.trim();
    clearTimeout(searchTimer);
    if (query.length < 2) {
      hideSuggest(kind);
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const results = await nominatimSearch(query);
        showSuggest(kind, results);
      } catch {
        hideSuggest(kind);
      }
    }, 400);
  });
}

function render() {
  const rides = loadRides().sort((a, b) => b.createdAt - a.createdAt);
  els.rideCount.textContent = String(rides.length);
  if (!rides.length) {
    els.passengerRides.innerHTML = `<li class="empty">ما عندك حتى حجز. أكّد طلب جديد من فوق.</li>`;
    els.driverRides.innerHTML = `<li class="empty">ما فماش طلبات توّا.</li>`;
    return;
  }
  els.passengerRides.innerHTML = rides.map((ride) => rideCard(ride, "passenger")).join("");
  els.driverRides.innerHTML = rides.map((ride) => rideCard(ride, "driver")).join("");
}

function rideCard(ride, role) {
  const actions =
    role === "passenger"
      ? ride.status === "pending"
        ? `<button class="ghost" data-action="cancel" data-id="${ride.id}">إلغاء</button>`
        : ""
      : driverActions(ride);
  const km = ride.km ? ` · ${ride.km.toFixed(1)} كم` : "";
  return `
    <li class="ride">
      <span class="status ${ride.status}">${statusLabel(ride.status)}</span>
      <h3>${escapeHtml(ride.from)} ← ${escapeHtml(ride.to)}</h3>
      <p class="meta">${ride.date} · ${ride.time} · ${carLabel(ride.car)} · ${ride.seats} ركاب · ${ride.price.toFixed(1)} د.ت${km}</p>
      <p class="meta">${escapeHtml(ride.name)} · ${escapeHtml(ride.phone)}${ride.driver ? ` · السائق: ${escapeHtml(ride.driver)}` : ""}</p>
      ${ride.note ? `<p class="meta">${escapeHtml(ride.note)}</p>` : ""}
      <div class="actions">${actions}</div>
    </li>
  `;
}

function driverActions(ride) {
  if (ride.status === "pending") {
    return `<button class="ghost" data-action="accept" data-id="${ride.id}">قبول</button>
            <button class="ghost" data-action="cancel" data-id="${ride.id}">رفض</button>`;
  }
  if (ride.status === "accepted") {
    return `<button class="ghost" data-action="enroute" data-id="${ride.id}">خرجت للراكب</button>`;
  }
  if (ride.status === "enroute") {
    return `<button class="ghost" data-action="done" data-id="${ride.id}">كمّلت الرحلة</button>`;
  }
  return "";
}

function setStatus(id, status) {
  const rides = loadRides();
  const ride = rides.find((item) => item.id === id);
  if (!ride) return;
  ride.status = status;
  if (status === "accepted") {
    ride.driver = els.driverName.value.trim() || "سائق Taxiette";
  }
  saveRides(rides);
  render();
}

function setPick(kind) {
  state.pick = kind;
  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pick === kind);
  });
  els.mapHint.textContent =
    kind === "from" ? "انقر على الخريطة باش تحط نقطة الانطلاق." : "انقر على الخريطة باش تحط الوجهة.";
}

els.date.value = todayISO();
els.time.value = nowTime();
initMap();
bindSearch("from");
bindSearch("to");
render();

els.car.addEventListener("change", updateRouteAndPrice);

document.querySelectorAll("[data-pick]").forEach((button) => {
  button.addEventListener("click", () => setPick(button.dataset.pick));
});

document.querySelector("#use-gps").addEventListener("click", () => {
  if (!navigator.geolocation) {
    alert("المتصفح ما يدعمش تحديد الموقع.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const place = await reverseGeocode(pos.coords.latitude, pos.coords.longitude);
      await setPlace("from", place || {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        display_name: "موقعي الحالي",
        type: "gps",
      });
      setPick("to");
    },
    () => alert("ما قدرناش ناخذو موقعك.")
  );
});

[els.fromSuggest, els.toSuggest].forEach((list) => {
  list.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-index]");
    if (!button) return;
    const kind = button.dataset.kind;
    const place = list._results?.[Number(button.dataset.index)];
    if (place) await setPlace(kind, place);
  });
});

els.nearbyList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-nearby]");
  if (!button) return;
  setPick("to");
  await setPlace("to", {
    lat: Number(button.dataset.lat),
    lon: Number(button.dataset.lon),
    display_name: button.dataset.name,
    name: button.dataset.name,
    type: button.dataset.kind,
    boundingbox: [
      Number(button.dataset.lat) - 0.0008,
      Number(button.dataset.lat) + 0.0008,
      Number(button.dataset.lon) - 0.0008,
      Number(button.dataset.lon) + 0.0008,
    ],
  });
});

document.querySelectorAll("[data-role]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-role]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    const isDriver = button.dataset.role === "driver";
    els.passengerView.hidden = isDriver;
    els.driverView.hidden = !isDriver;
    if (!isDriver) setTimeout(() => map.invalidateSize(), 120);
  });
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.from || !state.to) {
    alert("اختار الانطلاق والوجهة من البحث أو من الخريطة.");
    return;
  }
  const km = state.roadKm || state.km;
  if (km < 0.05) {
    alert("اختار وجهة مختلفة على نقطة الانطلاق.");
    return;
  }
  const ride = {
    id: crypto.randomUUID ? crypto.randomUUID() : `ride-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: document.querySelector("#name").value.trim(),
    phone: document.querySelector("#phone").value.trim(),
    from: state.from.display_name || placeTitle(state.from),
    to: state.to.display_name || placeTitle(state.to),
    fromCoord: { lat: Number(state.from.lat), lon: Number(state.from.lon) },
    toCoord: { lat: Number(state.to.lat), lon: Number(state.to.lon) },
    km,
    date: els.date.value,
    time: els.time.value,
    car: els.car.value,
    seats: Number(document.querySelector("#seats").value) || 1,
    note: document.querySelector("#note").value.trim(),
    price: estimatePrice(km, els.car.value),
    status: "pending",
    createdAt: Date.now(),
    driver: "",
  };
  const rides = loadRides();
  rides.push(ride);
  saveRides(rides);
  els.form.reset();
  els.date.value = todayISO();
  els.time.value = nowTime();
  state.from = null;
  state.to = null;
  state.km = 0;
  state.roadKm = 0;
  [fromMarker, toMarker, fromBox, toBox, routeLine].forEach((layer) => layer?.remove());
  fromMarker = toMarker = fromBox = toBox = routeLine = null;
  els.placeDims.hidden = true;
  els.nearby.hidden = true;
  els.estimate.hidden = true;
  setPick("from");
  map.setView(TUNIS, 12);
  render();
});

document.body.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const nextStatus = {
    cancel: "cancelled",
    accept: "accepted",
    enroute: "enroute",
    done: "done",
  }[button.dataset.action];
  if (!nextStatus) return;
  setStatus(button.dataset.id, nextStatus);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".suggest-wrap")) {
    hideSuggest("from");
    hideSuggest("to");
  }
});
