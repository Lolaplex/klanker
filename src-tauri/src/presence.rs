//! Presence offers — RFC-0003 road declarations read from a shared registry.
//!
//! Each klanker publishes a signed `road-declaration/1` document announcing
//! where it is reachable. Consumers verify the Ed25519 signature against the
//! embedded `did:key` and probe `/health` for liveness separately — an offer
//! is a claim, never truth. Forged or expired offers are reported with their
//! failure reason, never silently dropped.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DOC_TYPE: &str = "road-declaration/1";
const DID_PREFIX: &str = "did:key:z";
/// Offer lifetime. A publisher that wants persistence republishes (RFC-0003 §4).
const OFFER_TTL_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize)]
pub struct PresenceRoad {
    pub kind: String,
    pub addr: String,
    #[serde(default)]
    pub priority: u64,
    /// Usable relay origin — `addr` verbatim when it carries a scheme,
    /// otherwise `https://{addr}` (tailnet/https roads are TLS by default).
    pub endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PresenceOffer {
    /// Registry filename (e.g. `sigma.road.json`).
    pub file: String,
    /// Filename stem — the human label; the document carries no name field.
    pub label: String,
    /// Verified signer identity (empty on parse failures before `id`).
    pub did: String,
    pub roads: Vec<PresenceRoad>,
    pub iat: u64,
    pub exp: u64,
    pub valid: bool,
    /// Empty when `valid`; otherwise the exact refusal reason.
    pub reason: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn endpoint_of(kind: &str, addr: &str) -> String {
    if addr.contains("://") {
        return addr.to_string();
    }
    match kind {
        "http" => format!("http://{addr}"),
        _ => format!("https://{addr}"),
    }
}

/// obol.py `canonical()`: compact JSON, keys sorted — serde_json::Map is a
/// BTreeMap, so serialization order is already canonical.
fn canonical(doc: &Value) -> Vec<u8> {
    let mut stripped = doc.clone();
    if let Some(obj) = stripped.as_object_mut() {
        obj.remove("sig");
    }
    serde_json::to_vec(&stripped).unwrap_or_default()
}

/// `did:key:z` + bs58(0xed01 || pubkey32) — same construction as obol.py `did_key()`.
fn did_pubkey(did: &str) -> Result<[u8; 32], String> {
    let raw = bs58::decode(did.strip_prefix(DID_PREFIX).ok_or("id is not a did:key")?)
        .into_vec()
        .map_err(|e| format!("did:key multibase decode failed: {e}"))?;
    if raw.len() != 34 || raw[0] != 0xed || raw[1] != 0x01 {
        return Err("did:key does not carry an ed25519 key".into());
    }
    let mut pub_bytes = [0u8; 32];
    pub_bytes.copy_from_slice(&raw[2..]);
    Ok(pub_bytes)
}

fn verify_doc(doc: &Value) -> Result<(String, Vec<PresenceRoad>, u64, u64), String> {
    if doc.get("type").and_then(Value::as_str) != Some(DOC_TYPE) {
        return Err(format!("type is not {DOC_TYPE}"));
    }
    let did = doc
        .get("id")
        .and_then(Value::as_str)
        .ok_or("missing id")?
        .to_string();
    let iat = doc.get("iat").and_then(Value::as_u64).unwrap_or(0);
    let exp = doc.get("exp").and_then(Value::as_u64).ok_or("missing exp")?;
    if exp <= now_secs() {
        return Err(format!("expired (exp {exp})"));
    }
    let sig_b64 = doc.get("sig").and_then(Value::as_str).ok_or("missing sig")?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|e| format!("sig is not base64url: {e}"))?;
    let signature = Signature::from_slice(&sig_bytes).map_err(|e| format!("sig malformed: {e}"))?;
    let key = VerifyingKey::from_bytes(&did_pubkey(&did)?)
        .map_err(|e| format!("did:key is not a valid ed25519 pubkey: {e}"))?;
    key.verify_strict(&canonical(doc), &signature)
        .map_err(|_| "signature does not verify".to_string())?;

    let mut roads = Vec::new();
    for entry in doc
        .get("roads")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
        let addr = entry.get("addr").and_then(Value::as_str).unwrap_or("").to_string();
        if addr.is_empty() {
            continue;
        }
        let priority = entry.get("priority").and_then(Value::as_u64).unwrap_or(10);
        let endpoint = endpoint_of(&kind, &addr);
        roads.push(PresenceRoad {
            kind,
            addr,
            priority,
            endpoint,
        });
    }
    roads.sort_by_key(|r| r.priority);
    Ok((did, roads, iat, exp))
}

fn label_of(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    name.strip_suffix(".road.json")
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(&name)
        .to_string()
}

fn scan_file(path: &Path) -> PresenceOffer {
    let file = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let label = label_of(path);
    let reject = |reason: String| PresenceOffer {
        file: file.clone(),
        label: label.clone(),
        did: String::new(),
        roads: Vec::new(),
        iat: 0,
        exp: 0,
        valid: false,
        reason,
    };
    let body = match fs::read_to_string(path) {
        Ok(b) => b,
        Err(e) => return reject(format!("unreadable: {e}")),
    };
    let doc: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => return reject(format!("not json: {e}")),
    };
    match verify_doc(&doc) {
        Ok((did, roads, iat, exp)) => PresenceOffer {
            file,
            label,
            did,
            roads,
            iat,
            exp,
            valid: true,
            reason: String::new(),
        },
        Err(reason) => {
            let mut offer = reject(reason);
            offer.did = doc
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            offer.iat = doc.get("iat").and_then(Value::as_u64).unwrap_or(0);
            offer.exp = doc.get("exp").and_then(Value::as_u64).unwrap_or(0);
            offer
        }
    }
}

/// Every `*.json` in the registry becomes exactly one offer row — parse and
/// verification failures surface as invalid rows, never dropped entries.
/// A missing directory is an empty registry, not an error.
pub fn scan_registry(dir: &Path) -> Result<Vec<PresenceOffer>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map_err(|e| format!("failed to read {}: {e}", dir.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    entries.sort();
    Ok(entries.iter().map(|p| scan_file(p)).collect())
}

pub fn default_registry() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".klanker")
        .join("presence")
}

/// Mint + sign + write a declaration. Signing shells out to
/// `python -m agents_keys` (the suite's key-custody CLI — desktop never
/// reads the secret file). The finished document is self-verified before
/// it touches the registry: an unverifiable offer must never be published.
pub(crate) fn publish_offer(
    dir: &Path,
    python: &crate::commands::PythonInv,
    key_slug: &str,
    label: &str,
    kind: &str,
    addr: &str,
) -> Result<PresenceOffer, String> {
    let run = |args: &[&str]| -> Result<String, String> {
        let mut cmd = crate::commands::silent_command(&python.program);
        cmd.args(&python.prefix);
        cmd.args(args);
        let out = cmd
            .output()
            .map_err(|e| format!("failed to run agents_keys: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "agents_keys {} failed: {}",
                args.first().copied().unwrap_or(""),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    let did = run(&["-m", "agents_keys", "did", key_slug])?;
    if !did.starts_with(DID_PREFIX) {
        return Err(format!("agents_keys did returned a non-did:key line: {did}"));
    }
    let iat = now_secs();
    let mut doc = Map::new();
    doc.insert("type".into(), Value::String(DOC_TYPE.into()));
    doc.insert("id".into(), Value::String(did.clone()));
    doc.insert(
        "roads".into(),
        serde_json::json!([{ "kind": kind, "addr": addr, "priority": 10 }]),
    );
    doc.insert("iat".into(), Value::from(iat));
    doc.insert("exp".into(), Value::from(iat + OFFER_TTL_SECS));
    let doc = Value::Object(doc);

    let payload = String::from_utf8(canonical(&doc)).unwrap_or_default();
    let sig_hex = run(&["-m", "agents_keys", "sign", key_slug, &payload])?;
    let sig_bytes = hex::decode(sig_hex.trim())
        .map_err(|e| format!("agents_keys sign returned non-hex sig: {e}"))?;
    let mut signed = doc.clone();
    signed
        .as_object_mut()
        .unwrap()
        .insert("sig".into(), Value::String(URL_SAFE_NO_PAD.encode(sig_bytes)));

    // Falsifier: the publisher must verify its own document before writing.
    verify_doc(&signed).map_err(|e| format!("self-verify failed, refusing to publish: {e}"))?;

    let slug: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    fs::create_dir_all(dir).map_err(|e| format!("failed to create {}: {e}", dir.display()))?;
    let path = dir.join(format!("{slug}.road.json"));
    fs::write(&path, serde_json::to_string_pretty(&signed).unwrap_or_default())
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;
    Ok(scan_file(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn test_did_and_signer() -> (String, SigningKey) {
        let signer = SigningKey::from_bytes(&[9u8; 32]);
        let mut prefixed = vec![0xed, 0x01];
        prefixed.extend_from_slice(&signer.verifying_key().to_bytes());
        (format!("did:key:z{}", bs58::encode(prefixed).into_string()), signer)
    }

    fn sign_doc(signer: &SigningKey, doc: &Value) -> Value {
        use ed25519_dalek::Signer;
        let sig = signer.sign(&canonical(doc));
        let mut signed = doc.clone();
        signed
            .as_object_mut()
            .unwrap()
            .insert("sig".into(), Value::String(URL_SAFE_NO_PAD.encode(sig.to_bytes())));
        signed
    }

    fn doc_for(did: &str, exp: u64) -> Value {
        serde_json::json!({
            "type": DOC_TYPE,
            "id": did,
            "roads": [{ "kind": "tailscale", "addr": "pc.tailnet.ts.net", "priority": 10 }],
            "iat": now_secs(),
            "exp": exp,
        })
    }

    fn fixture_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("klanker-presence-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn valid_expired_and_forged_all_report() {
        let (did, signer) = test_did_and_signer();
        let dir = fixture_dir();

        let good = sign_doc(&signer, &doc_for(&did, now_secs() + 3600));
        fs::write(
            dir.join("good.road.json"),
            serde_json::to_string(&good).unwrap(),
        )
        .unwrap();

        let stale = sign_doc(&signer, &doc_for(&did, now_secs() - 10));
        fs::write(
            dir.join("stale.road.json"),
            serde_json::to_string(&stale).unwrap(),
        )
        .unwrap();

        let (other_did, other_signer) = test_did_and_signer();
        let _ = other_did;
        let mut forged = doc_for(&did, now_secs() + 3600);
        let wrong = SigningKey::from_bytes(&[4u8; 32]);
        forged = sign_doc(&wrong, &forged);
        let _ = other_signer;
        fs::write(
            dir.join("forged.road.json"),
            serde_json::to_string(&forged).unwrap(),
        )
        .unwrap();

        fs::write(dir.join("broken.json"), "{not json").unwrap();

        let offers = scan_registry(&dir).unwrap();
        assert_eq!(offers.len(), 4);
        let good_offer = offers.iter().find(|o| o.label == "good").unwrap();
        assert!(good_offer.valid, "good offer rejected: {}", good_offer.reason);
        assert_eq!(good_offer.did, did);
        assert_eq!(good_offer.roads[0].endpoint, "https://pc.tailnet.ts.net");

        let stale_offer = offers.iter().find(|o| o.label == "stale").unwrap();
        assert!(!stale_offer.valid);
        assert!(stale_offer.reason.contains("expired"));

        let forged_offer = offers.iter().find(|o| o.label == "forged").unwrap();
        assert!(!forged_offer.valid);
        assert!(forged_offer.reason.contains("signature"));
        assert_eq!(forged_offer.did, did, "rejected offers still name their claimant");

        let broken = offers.iter().find(|o| o.label == "broken").unwrap();
        assert!(!broken.valid);
        assert!(broken.reason.contains("not json"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_registry_is_empty_not_error() {
        let dir = std::env::temp_dir().join(format!("klanker-presence-absent-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(scan_registry(&dir).unwrap().is_empty());
    }
}
