// =====================================================================
// FIREBASE + CLOUDINARY ADAPTER
// Mimics the subset of the Supabase JS client's API that this app uses,
// so the other ~4000 lines of app code (sb.from()/.eq()/.rpc() etc.)
// don't need to be rewritten one call-site at a time.
//
// WHAT WORKS NOW (Phase 1):
//   - sb.auth.signUp / signInWithPassword / signOut / getSession /
//     onAuthStateChange / resetPasswordForEmail
//   - sb.from(table).select().eq().in().is().order().limit().range()
//     .maybeSingle()/.single(), .insert(), .update(), .upsert(), .delete()
//   - sb.storage.from(bucket).upload/getPublicUrl  (backed by Cloudinary)
//
// NOT YET MIGRATED (Phase 2 — will throw a clear error if called):
//   - sb.rpc(...)  — folder_rank_stats, set_rank_stats, redeem_coupon,
//     redeem_share_code, question_accuracy_stats, get_today_percentile,
//     admin_*_rank_list, set_rank_list_public, security-question fns
//   These need to be rewritten as plain JS functions reading/writing
//   Firestore directly. Listed here so nothing fails silently.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut as fbSignOut, onAuthStateChanged, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  deleteDoc, query, where, orderBy, limit as fsLimit, startAt, writeBatch,
  increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBgiNb8lQO-N4yqsf9Zi2ioss64ra5sC90",
  authDomain: "qbankconsole.firebaseapp.com",
  projectId: "qbankconsole",
  storageBucket: "qbankconsole.firebasestorage.app",
  messagingSenderId: "389663023635",
  appId: "1:389663023635:web:b093142d039677ca0c95e6",
  measurementId: "G-726D67BDT2"
};

const CLOUDINARY_CLOUD = "t49sum7z";
const CLOUDINARY_PRESET = "Vithal";

const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ---------- helpers ----------
function toSession(user){
  if(!user) return null;
  return { user: { id: user.uid, email: user.email } };
}
function wrapErr(e){ return { message: e?.message || String(e), code: e?.code }; }

// ---------- auth ----------
const auth = {
  async getSession(){
    return { data: { session: toSession(fbAuth.currentUser) } };
  },
  onAuthStateChange(cb){
    const unsub = onAuthStateChanged(fbAuth, (user)=>{
      cb('AUTH_STATE_CHANGE', toSession(user));
    });
    return { data: { subscription: { unsubscribe: unsub } } };
  },
  async signUp({ email, password }){
    try{
      const cred = await createUserWithEmailAndPassword(fbAuth, email, password);
      return { data: { user: cred.user }, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  },
  async signInWithPassword({ email, password }){
    try{
      const cred = await signInWithEmailAndPassword(fbAuth, email, password);
      return { data: { user: cred.user }, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  },
  async signOut(){
    try{ await fbSignOut(fbAuth); return { error: null }; }
    catch(e){ return { error: wrapErr(e) }; }
  },
  async resetPasswordForEmail(email){
    try{ await sendPasswordResetEmail(fbAuth, email); return { error: null }; }
    catch(e){ return { error: wrapErr(e) }; }
  }
};

// ---------- firestore query builder ----------
// Supports the chain patterns used in this app: .select().eq().in().is()
// .order().limit().range().maybeSingle()/.single(), plus .insert/.update/
// .upsert/.delete(). Each builder is awaitable (thenable) and resolves to
// { data, error } like Supabase does.
class QB {
  constructor(table){
    this.table = table;
    this.filters = [];       // {field, op, value}
    this._order = [];        // {field, ascending}
    this._limit = null;
    this._mode = 'select';   // select | insert | update | upsert | delete
    this._payload = null;
    this._wantSingle = false;
    this._maybeSingle = false;
    this._onConflict = null;
  }
  select(cols, opts){ if(opts && opts.count) this._wantCount = true; return this; } // Firestore always returns full docs; column list is ignored
  eq(field, value){ this.filters.push({field, op:'==', value}); return this; }
  neq(field, value){ this.filters.push({field, op:'!=', value}); return this; }
  gte(field, value){ this.filters.push({field, op:'>=', value}); return this; }
  lte(field, value){ this.filters.push({field, op:'<=', value}); return this; }
  gt(field, value){ this.filters.push({field, op:'>', value}); return this; }
  lt(field, value){ this.filters.push({field, op:'<', value}); return this; }
  in(field, values){ this.filters.push({field, op:'in', value: values}); return this; }
  is(field, value){ this.filters.push({field, op:'==', value: value===null?null:value}); return this; }
  ilike(field, pattern){
    // Firestore has no wildcard text search. Fetch broader set and filter
    // client-side (fine at this app's scale; revisit if a table gets huge).
    const needle = String(pattern).replace(/%/g,'').toLowerCase();
    this.filters.push({field, op:'ilike-client', value: needle});
    return this;
  }
  order(field, opts){ this._order.push({field, ascending: opts?.ascending !== false}); return this; }
  limit(n){ this._limit = n; return this; }
  range(from, to){ this._rangeFrom = from; this._rangeTo = to; return this; }
  maybeSingle(){ this._maybeSingle = true; return this; }
  single(){ this._wantSingle = true; return this; }
  insert(obj){ this._mode='insert'; this._payload = Array.isArray(obj)?obj:[obj]; return this; }
  update(obj){ this._mode='update'; this._payload = obj; return this; }
  upsert(obj, opts){ this._mode='upsert'; this._payload = obj; this._onConflict = opts?.onConflict || 'id'; return this; }
  delete(){ this._mode='delete'; return this; }

  async _runSelect(){
    const col = collection(db, this.table);
    const clientFilters = this.filters.filter(f=>f.op==='ilike-client');
    const serverFilters = this.filters.filter(f=>f.op!=='ilike-client');
    const constraints = [];
    for(const f of serverFilters){
      if(f.op==='in'){
        if(!f.value || !f.value.length) return { data: [], error: null }; // empty .in() -> no results
        // Firestore 'in' caps at 30 values — chunk + merge if exceeded
        if(f.value.length > 30){
          const chunks = [];
          for(let i=0;i<f.value.length;i+=30) chunks.push(f.value.slice(i,i+30));
          const results = await Promise.all(chunks.map(async ch=>{
            const cs = [...constraints, where(f.field,'in',ch)];
            const snap = await getDocs(query(col, ...cs));
            return snap.docs.map(d=>({id:d.id, ...d.data()}));
          }));
          let merged = results.flat();
          merged = this._applyOrderLimitClient(merged);
          merged = this._applyClientFilters(merged, clientFilters);
          return { data: this._finish(merged), error: null };
        }
      }
      constraints.push(where(f.field, f.op, f.value));
    }
    for(const o of this._order) constraints.push(orderBy(o.field, o.ascending?'asc':'desc'));
    if(this._limit) constraints.push(fsLimit(this._limit));
    try{
      const snap = await getDocs(query(col, ...constraints));
      let rows = snap.docs.map(d=>({id:d.id, ...d.data()}));
      rows = this._applyClientFilters(rows, clientFilters);
      if(this._wantCount) return { data: null, count: rows.length, error: null };
      return { data: this._finish(rows), error: null };
    }catch(e){ return { data: this._maybeSingle?null:[], count: 0, error: wrapErr(e) }; }
  }
  _applyClientFilters(rows, clientFilters){
    return rows.filter(r=> clientFilters.every(f=> String(r[f.field]||'').toLowerCase().includes(f.value)));
  }
  _applyOrderLimitClient(rows){
    for(const o of [...this._order].reverse()){
      rows.sort((a,b)=>{
        const av=a[o.field], bv=b[o.field];
        const cmp = av<bv?-1:av>bv?1:0;
        return o.ascending?cmp:-cmp;
      });
    }
    if(this._limit) rows = rows.slice(0, this._limit);
    return rows;
  }
  _finish(rows){
    if(this._maybeSingle) return rows[0] || null;
    if(this._wantSingle) return rows[0] || null;
    return rows;
  }
  async _runInsert(){
    const col = collection(db, this.table);
    const out = [];
    try{
      for(const obj of this._payload){
        const ref = await addDoc(col, obj);
        out.push({ id: ref.id, ...obj });
      }
      this._insertedResult = out;
      return { data: this._maybeSingle||this._wantSingle ? out[0] : out, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  }
  async _runUpdate(){
    try{
      const targets = await this._resolveTargetIds();
      for(const id of targets) await updateDoc(doc(db, this.table, id), this._payload);
      const merged = targets.map(id=>({ id, ...this._payload }));
      return { data: this._maybeSingle||this._wantSingle ? merged[0]||null : merged, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  }
  async _runUpsert(){
    try{
      const idVal = this._payload[this._onConflict];
      if(idVal){
        await setDoc(doc(db, this.table, idVal), this._payload, { merge: true });
        return { data: this._payload, error: null };
      }
      const ref = await addDoc(collection(db, this.table), this._payload);
      return { data: { id: ref.id, ...this._payload }, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  }
  async _runDelete(){
    try{
      const targets = await this._resolveTargetIds();
      const batch = writeBatch(db);
      targets.forEach(id=> batch.delete(doc(db, this.table, id)));
      await batch.commit();
      return { data: null, error: null };
    }catch(e){ return { data: null, error: wrapErr(e) }; }
  }
  async _resolveTargetIds(){
    // update()/delete() need the doc ids matching the .eq() filters applied
    const eqId = this.filters.find(f=>f.field==='id' && f.op==='==');
    if(eqId && this.filters.length===1) return [eqId.value];
    const col = collection(db, this.table);
    const constraints = this.filters.filter(f=>f.op!=='ilike-client').map(f=> where(f.field, f.op, f.value));
    const snap = await getDocs(query(col, ...constraints));
    return snap.docs.map(d=>d.id);
  }
  then(resolve, reject){
    const run = this._mode==='select' ? this._runSelect()
      : this._mode==='insert' ? this._runInsert()
      : this._mode==='update' ? this._runUpdate()
      : this._mode==='upsert' ? this._runUpsert()
      : this._runDelete();
    return run.then(resolve, reject);
  }
}

// ---------- cloudinary storage ----------
async function cloudinaryUpload(file, publicId){
  const fd = new FormData();
  fd.append('file', file);
  fd.append('upload_preset', CLOUDINARY_PRESET);
  fd.append('public_id', publicId);
  try{
    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, { method:'POST', body: fd });
    const json = await res.json();
    if(json.error) return { error: { message: json.error.message } };
    return { path: json.public_id, url: json.secure_url };
  }catch(e){ return { error: wrapErr(e) }; }
}
const storage = {
  from(bucket){
    return {
      async upload(path, file, opts){
        const publicId = `${bucket}/${path.replace(/\.[^.]+$/, '')}`;
        const res = await cloudinaryUpload(file, publicId);
        if(res.error) return { error: res.error };
        this._lastUrl = res.url;
        return { data: { path: res.path }, error: null };
      },
      getPublicUrl(path){
        const publicId = `${bucket}/${path.replace(/\.[^.]+$/, '')}`;
        // Deterministic URL — matches what upload() stored the file as.
        return { data: { publicUrl: `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/image/upload/${publicId}` } };
      },
      async createSignedUrl(path){
        // Cloudinary unsigned-preset assets are public by nature — there's
        // no real "signed, expiring" URL without a paid/signed setup, so
        // this just hands back the same public URL Supabase's signed-URL
        // callers expect the shape of.
        const publicId = `${bucket}/${path.replace(/\.[^.]+$/, '')}`;
        return { data: { signedUrl: `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/image/upload/${publicId}` }, error: null };
      },
      // list()/remove() aren't available from unsigned client uploads
      // (Cloudinary's list API needs the API secret, server-side only).
      // Since we upload with a fixed public_id per user, re-uploading
      // already overwrites the old file — so replaceUserFile() no longer
      // needs an explicit list+remove step. See index2.html changes.
      async list(){ return { data: [], error: null }; },
      async remove(){ return { data: null, error: null }; }
    };
  }
};

// ---------- rpc (Phase 2 — Firestore-backed implementations) ----------
// Postgres RPCs did their aggregation server-side; without a backend these
// run in the browser instead, reading the relevant Firestore docs and
// computing ranks/totals client-side. Fine at this app's solo/small-cohort
// scale — if the user base grows into the thousands, the *_rank_list and
// question_accuracy_stats reads (which scan whole collections) are the
// first candidates to move into a real backend or scheduled aggregation.

async function getAllDocs(table, constraints){
  const snap = await getDocs(query(collection(db, table), ...constraints));
  return snap.docs.map(d=>({id:d.id, ...d.data()}));
}
// Firestore's 'in' operator caps at 30 values — chunk and merge.
async function getAllWhereIn(table, field, ids, extra=[]){
  if(!ids || !ids.length) return [];
  const chunks = [];
  for(let i=0;i<ids.length;i+=30) chunks.push(ids.slice(i,i+30));
  const results = await Promise.all(chunks.map(async ch=>{
    const snap = await getDocs(query(collection(db, table), where(field,'in',ch), ...extra));
    return snap.docs.map(d=>({id:d.id, ...d.data()}));
  }));
  return results.flat();
}
async function getProfilesByIds(ids){
  const rows = await getAllWhereIn('profiles', '__name__', ids);
  const byId = {}; rows.forEach(r=> byId[r.id]=r);
  return byId;
}
// rank = 1 + how many scored strictly higher; percentile = % of the field you beat.
function rankAndPercentile(allScores, mine){
  const total = allScores.length;
  const rank = allScores.filter(s=>s>mine).length + 1;
  const percentile = total>1 ? Math.round(((total-rank)/(total-1))*100) : 100;
  return { rank, total, percentile };
}
// Collapses a set of submitted attempts down to one (the latest) per user,
// or (when perSet=true) one latest attempt per user PER set — used for
// section/exam-type/overall totals that span several sets.
function latestPerUser(attempts){
  const byUser = {};
  attempts.forEach(a=>{
    const cur = byUser[a.user_id];
    if(!cur || new Date(a.submitted_at) > new Date(cur.submitted_at)) byUser[a.user_id] = a;
  });
  return byUser;
}
function latestPerUserPerSet(attempts){
  const byUser = {};
  attempts.forEach(a=>{
    byUser[a.user_id] = byUser[a.user_id] || {};
    const cur = byUser[a.user_id][a.set_id];
    if(!cur || new Date(a.submitted_at) > new Date(cur.submitted_at)) byUser[a.user_id][a.set_id] = a;
  });
  return byUser;
}
function sumAcrossSets(setMap){
  const vals = Object.values(setMap);
  return {
    sets_completed: vals.length,
    user_total: vals.reduce((n,a)=>n+(a.total_questions||0),0),
    user_correct: vals.reduce((n,a)=>n+(a.correct_count||0),0),
    user_score: vals.reduce((n,a)=>n+(a.score||0),0),
  };
}

async function rpcFolderRankStats({ p_folder_id, p_user_id }){
  const sets = await getAllDocs('sets', [where('folder_id','==',p_folder_id), where('user_id','==',null), where('set_type','==','main')]);
  const setIds = sets.map(s=>s.id);
  if(!setIds.length) return { data: [], error: null };
  const attempts = (await getAllWhereIn('attempts','set_id',setIds)).filter(a=>a.status==='submitted');
  const byUser = latestPerUserPerSet(attempts);
  const mineMap = byUser[p_user_id];
  if(!mineMap) return { data: [], error: null };
  const totals = Object.entries(byUser).map(([uid,setMap])=>({ user_id: uid, ...sumAcrossSets(setMap) }));
  const mine = totals.find(t=>t.user_id===p_user_id);
  const { rank, total, percentile } = rankAndPercentile(totals.map(t=>t.user_score), mine.user_score);
  return { data: [{ ...mine, sets_total: setIds.length, rank, total_attempts: total, percentile }], error: null };
}

async function rpcSetRankStats({ p_set_id, p_user_id }){
  const attempts = await getAllDocs('attempts', [where('set_id','==',p_set_id), where('status','==','submitted')]);
  const byUser = latestPerUser(attempts);
  const mine = byUser[p_user_id];
  if(!mine) return { data: [], error: null };
  const { rank, total, percentile } = rankAndPercentile(Object.values(byUser).map(a=>a.score||0), mine.score||0);
  return { data: [{ user_total: mine.total_questions, user_correct: mine.correct_count, user_score: mine.score, rank, total_attempts: total, percentile }], error: null };
}

async function rpcSetRankListPublic({ p_set_id, p_user_id }){
  const attempts = await getAllDocs('attempts', [where('set_id','==',p_set_id), where('status','==','submitted')]);
  const byUser = latestPerUser(attempts);
  const uids = Object.keys(byUser);
  const profiles = await getProfilesByIds(uids);
  const rows = uids.map(uid=>{
    const a = byUser[uid], p = profiles[uid]||{};
    return { name: p.name, correct_count: a.correct_count, total_questions: a.total_questions, score: a.score||0, is_me: uid===p_user_id };
  });
  rows.sort((a,b)=>b.score-a.score);
  rows.forEach((r,i)=>r.rnk=i+1);
  return { data: rows, error: null };
}

async function rpcQuestionAccuracyStats({ p_question_ids }){
  const ids = p_question_ids || [];
  const results = await Promise.all(ids.map(async qid=>{
    try{
      const snap = await getDoc(doc(db,'question_stats', qid));
      const d = snap.exists() ? snap.data() : { total:0, correct:0 };
      return { question_id: qid, total_attempts: d.total||0, correct_attempts: d.correct||0 };
    }catch(e){ return { question_id: qid, total_attempts:0, correct_attempts:0 }; }
  }));
  return { data: results, error: null };
}

async function rpcGetTodayPercentile(){
  const uid = fbAuth.currentUser?.uid;
  if(!uid) return { data: [], error: null };
  const start = new Date(); start.setHours(0,0,0,0);
  let attempts;
  try{
    attempts = await getAllDocs('attempts', [where('status','==','submitted'), where('submitted_at','>=', start.toISOString())]);
  }catch(e){
    // Needs a composite index the first time — Firestore's error includes a
    // direct "create it" link; open that link once in the console and retry.
    return { data: [], error: wrapErr(e) };
  }
  const byUser = {};
  attempts.forEach(a=>{ byUser[a.user_id] = (byUser[a.user_id]||0) + (a.total_questions||0); });
  const mine = byUser[uid] || 0;
  const vals = Object.values(byUser);
  if(!vals.length || !mine) return { data: [], error: null };
  const { rank, total, percentile } = rankAndPercentile(vals, mine);
  return { data: [{ percentile, rank, total_attempts: total }], error: null };
}

async function rpcRedeemShareCode({ p_code }){
  const rows = await getAllDocs('sets', [where('share_code','==',p_code)]);
  if(!rows.length) return { data: null, error: null };
  return { data: [rows[0]], error: null };
}

async function rpcRedeemCoupon({ p_code, p_user_id }){
  const rows = await getAllDocs('coupons', [where('code','==',p_code)]);
  if(!rows.length) return { data: [{ message:'Invalid code.' }], error: null };
  const coupon = rows[0];
  if(coupon.promoter_id === p_user_id) return { data: [{ message:"You can't use your own code." }], error: null };
  const profSnap = await getDoc(doc(db,'profiles', p_user_id));
  const prof = profSnap.exists() ? profSnap.data() : {};
  if(prof.referred_by_coupon) return { data: [{ message:'You already used a referral code.' }], error: null };
  const newUsage = (coupon.usage_count||0) + 1;
  await updateDoc(doc(db,'coupons', coupon.id), { usage_count: increment(1) });
  if(newUsage >= coupon.target_quota && !coupon.milestone_reached){
    await updateDoc(doc(db,'coupons', coupon.id), { milestone_reached: true });
    await updateDoc(doc(db,'profiles', coupon.promoter_id), {
      promoter_milestone_available: true, promoter_milestone_discount_pct: coupon.milestone_discount_pct
    });
  }
  await updateDoc(doc(db,'profiles', p_user_id), { referred_by_coupon: true, referral_discount_pct: coupon.referee_discount_pct });
  return { data: [{ discount_pct: coupon.referee_discount_pct }], error: null };
}

async function rpcAdminListUsers({ p_search }){
  const rows = await getAllDocs('profiles', []);
  let filtered = rows;
  if(p_search){
    const needle = p_search.toLowerCase();
    filtered = rows.filter(u=> (u.name||'').toLowerCase().includes(needle) || (u.email||'').toLowerCase().includes(needle));
  }
  filtered.sort((a,b)=> (a.name||a.email||'').localeCompare(b.name||b.email||''));
  return { data: filtered, error: null };
}

async function rpcAdminSetSecurityQuestion({ p_user_id, p_question, p_answer }){
  // Kept only for the admin-panel UI's sake — password reset itself now
  // goes through Firebase's email link, so this is just a saved note.
  try{ await updateDoc(doc(db,'profiles', p_user_id), { security_question: p_question, security_answer_note: p_answer }); return { error: null }; }
  catch(e){ return { error: wrapErr(e) }; }
}

function buildRankRows(byUserMap, profiles, aggregateFn){
  const rows = Object.entries(byUserMap).map(([uid, val])=>{
    const p = profiles[uid] || {};
    return { name: p.name, batch: p.batch, college: p.college, email: p.email, ...aggregateFn(val) };
  });
  rows.sort((a,b)=>b.score-a.score);
  rows.forEach((r,i)=>r.rnk=i+1);
  return rows;
}

async function rpcAdminSetRankList({ p_set_id }){
  const attempts = await getAllDocs('attempts', [where('set_id','==',p_set_id), where('status','==','submitted')]);
  const byUser = latestPerUser(attempts);
  const profiles = await getProfilesByIds(Object.keys(byUser));
  const rows = buildRankRows(byUser, profiles, a=>({ correct_count:a.correct_count, total_questions:a.total_questions, score:a.score||0 }));
  return { data: rows, error: null };
}

async function setsToRankRows(sets){
  const setIds = sets.filter(s=>!s.user_id && s.set_type==='main').map(s=>s.id);
  if(!setIds.length) return [];
  const attempts = (await getAllWhereIn('attempts','set_id',setIds)).filter(a=>a.status==='submitted');
  const byUser = latestPerUserPerSet(attempts);
  const profiles = await getProfilesByIds(Object.keys(byUser));
  return buildRankRows(byUser, profiles, sumAcrossSets);
}

async function rpcAdminSubjectRankList({ p_folder_id, p_subject }){
  const sets = await getAllDocs('sets', [where('folder_id','==',p_folder_id), where('subject','==',p_subject), where('user_id','==',null)]);
  return { data: await setsToRankRows(sets), error: null };
}

async function rpcAdminFolderRankList({ p_folder_id }){
  const sets = await getAllDocs('sets', [where('folder_id','==',p_folder_id), where('user_id','==',null), where('set_type','==','main')]);
  return { data: await setsToRankRows(sets), error: null };
}

async function rpcAdminExamtypeRankList({ p_exam_type }){
  const folders = await getAllDocs('folders', [where('exam_type','==',p_exam_type)]);
  const sets = await getAllWhereIn('sets','folder_id', folders.map(f=>f.id));
  return { data: await setsToRankRows(sets), error: null };
}

async function rpcAdminOverallRankList(){
  const attempts = await getAllDocs('attempts', [where('status','==','submitted')]);
  const byUser = latestPerUserPerSet(attempts);
  const profiles = await getProfilesByIds(Object.keys(byUser));
  const rows = buildRankRows(byUser, profiles, sumAcrossSets);
  return { data: rows, error: null };
}

const RPC_MAP = {
  folder_rank_stats: rpcFolderRankStats,
  set_rank_stats: rpcSetRankStats,
  set_rank_list_public: rpcSetRankListPublic,
  question_accuracy_stats: rpcQuestionAccuracyStats,
  get_today_percentile: rpcGetTodayPercentile,
  redeem_share_code: rpcRedeemShareCode,
  redeem_coupon: rpcRedeemCoupon,
  admin_list_users: rpcAdminListUsers,
  admin_set_security_question: rpcAdminSetSecurityQuestion,
  admin_set_rank_list: rpcAdminSetRankList,
  admin_subject_rank_list: rpcAdminSubjectRankList,
  admin_folder_rank_list: rpcAdminFolderRankList,
  admin_examtype_rank_list: rpcAdminExamtypeRankList,
  admin_overall_rank_list: rpcAdminOverallRankList,
};
async function rpc(name, params){
  const fn = RPC_MAP[name];
  if(!fn){
    console.error(`[fb-adapter] sb.rpc('${name}') has no Firestore implementation.`);
    return { data: null, error: { message: `'${name}' isn't implemented.` } };
  }
  try{ return await fn(params||{}); }
  catch(e){ return { data: null, error: wrapErr(e) }; }
}

// Called from submitAttempt() in index2.html right after an attempt is
// marked submitted, to keep each question's community accuracy counters
// (used by question_accuracy_stats above) up to date incrementally instead
// of scanning every attempt on every read.
export async function bumpQuestionStats(pairs){
  // pairs: [{ questionId, wasCorrect }]
  await Promise.all(pairs.map(({questionId, wasCorrect})=>
    setDoc(doc(db,'question_stats', questionId), {
      total: increment(1), correct: increment(wasCorrect?1:0)
    }, { merge:true })
  ));
}

export const sb = {
  auth,
  storage,
  from(table){ return new QB(table); },
  rpc
};
