// 存储调度：按环境变量 STORAGE_TYPE 在 D1 与 KV 之间切换
import { getStorageType } from './config.js';
import { insertD1, queryD1 } from './db.js';
import { insertKV, queryKV } from './kv.js';

export async function saveSnapshots(env, rows) {
  return getStorageType(env) === 'kv'
    ? insertKV(env, rows)
    : insertD1(env.DB, rows);
}

export async function querySnapshots(env, params) {
  return getStorageType(env) === 'kv'
    ? queryKV(env, params)
    : queryD1(env.DB, params);
}
