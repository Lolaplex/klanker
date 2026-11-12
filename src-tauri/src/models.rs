use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstanceKind {
    Local,
    Remote,
}

impl Default for InstanceKind {
    fn default() -> Self {
        Self::Local
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceEndpoint {
    pub base_url: String,
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceStartSpec {
    pub argv: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceTailscale {
    pub node: String,
    #[serde(default)]
    pub fqdn: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KlankerInstance {
    pub id: String,
    pub name: String,
    pub slug: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Never written to the instance file: `without_secrets` clears it before a save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default = "default_workspace")]
    pub workspace: String,
    /// Confine tools to `workspace`. Defaults to true so an older instance file
    /// keeps the confinement it had before the switch existed.
    #[serde(default = "default_true")]
    pub lock_workspace: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub sensors: HashMap<String, bool>,
    #[serde(default)]
    pub kind: InstanceKind,
    #[serde(default)]
    pub endpoint: Option<InstanceEndpoint>,
    #[serde(default)]
    pub start_cmd: Option<InstanceStartSpec>,
    #[serde(default)]
    pub tailscale: Option<InstanceTailscale>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub user_id: String,
    /// UI boundary: accepted on save, moved to the OS keychain, never persisted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// True only on the value sent to the webview. Disk writes leave this false.
    #[serde(default, skip_serializing_if = "is_false")]
    pub has_secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn default_model() -> String {
    String::new()
}

pub fn default_window_workspace() -> String {
    r"C:\Users\felix\Coding".to_string()
}

fn default_workspace() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

fn default_true() -> bool {
    true
}

fn default_port() -> u16 {
    8787
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessStatus {
    pub is_running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub last_ping: Option<String>,
    /// running | stopped | port_busy | not_owned
    pub state: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnResponse {
    pub reply: String,
    pub session: String,
    pub user_id: String,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracePage {
    pub lines: Vec<String>,
    /// Empty when `lines` is the instance trace tail. Otherwise the empty-state sentence.
    pub note: String,
}

/// One discovered endpoint: a peer answering the relay `/health` contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
    pub hostname: String,
    pub ip: String,
    #[serde(default)]
    pub fqdn: Option<String>,
    /// `http://{ip}:{port}` — first origin per (peer, port) that returned `{"ok":true}`.
    pub endpoint: String,
}

/// One pending tool approval from `$AGENTS_RELAY_STATE/approvals`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingApproval {
    pub id: String,
    pub tool: String,
    pub summary: String,
}

fn default_settings_provider() -> String {
    "echo".to_string()
}

fn default_lmstudio_url() -> String {
    "http://127.0.0.1:1234/v1".to_string()
}

/// Model ids for one provider. Echo has neither list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderModels {
    #[serde(default)]
    pub openrouter: Vec<String>,
    #[serde(default)]
    pub lmstudio: Vec<String>,
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in items {
        let Some(id) = item.as_str() else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() || out.iter().any(|have| have == id) {
            continue;
        }
        out.push(id.to_string());
    }
    out
}

fn buckets(value: &Value) -> ProviderModels {
    ProviderModels {
        openrouter: string_list(value.get("openrouter")),
        lmstudio: string_list(value.get("lmstudio")),
    }
}

fn lists_from_recent(value: &Value) -> ProviderModels {
    match value {
        Value::Object(_) => buckets(value),
        _ => ProviderModels::default(),
    }
}

fn lists_from_favorites(value: &Value) -> ProviderModels {
    match value {
        Value::Object(_) => buckets(value),
        Value::Array(items) => {
            let mut out = ProviderModels::default();
            for item in items {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                let provider = obj
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                let model = obj
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if model.is_empty() {
                    continue;
                }
                let bucket = match provider.as_str() {
                    "openrouter" => &mut out.openrouter,
                    "lmstudio" | "lmstudio.local" => &mut out.lmstudio,
                    _ => continue,
                };
                if bucket.iter().any(|have| have == model) {
                    continue;
                }
                bucket.push(model.to_string());
            }
            out
        }
        _ => ProviderModels::default(),
    }
}

fn de_recent<'de, D>(deserializer: D) -> Result<ProviderModels, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(lists_from_recent(&value))
}

fn de_favorites<'de, D>(deserializer: D) -> Result<ProviderModels, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(lists_from_favorites(&value))
}

/// Window settings. The OpenRouter key lives in the OS credential store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesktopSettings {
    #[serde(default = "default_settings_provider")]
    pub provider: String,
    /// Accepted on save. Cleared before the file is written and before the webview sees it.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub openrouter_api_key: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub openrouter_key_set: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_window_workspace")]
    pub workspace: String,
    #[serde(default = "default_lmstudio_url")]
    pub lmstudio_base_url: String,
    #[serde(default, deserialize_with = "de_recent")]
    pub recent_models: ProviderModels,
    #[serde(default, deserialize_with = "de_favorites")]
    pub favorites: ProviderModels,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_instance_json_still_parses() {
        let old = r#"{
            "id": "default",
            "name": "Default Klanker",
            "slug": "default",
            "role": "Adaptive Slimemold AI Assistant on Lolaplex Suite",
            "provider": "lmstudio.local",
            "model": "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF",
            "base_url": "http://127.0.0.1:1234/v1",
            "workspace": "C:\\Users\\felix\\Coding",
            "port": 8000,
            "system_prompt": "dense",
            "sensors": {"memory": true},
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let inst: KlankerInstance = serde_json::from_str(old).unwrap();
        assert_eq!(inst.kind, InstanceKind::Local);
        assert!(inst.endpoint.is_none());
        assert!(inst.start_cmd.is_none());
        assert!(inst.tailscale.is_none());
    }

    #[test]
    fn v2_remote_instance_roundtrips() {
        let inst = KlankerInstance {
            id: "pvs".into(),
            name: "PVS".into(),
            slug: "pvs".into(),
            role: "remote".into(),
            provider: "openai.default".into(),
            model: "gpt-5".into(),
            base_url: None,
            api_key: None,
            workspace: String::new(),
            lock_workspace: true,
            port: 8787,
            system_prompt: String::new(),
            sensors: HashMap::new(),
            kind: InstanceKind::Remote,
            endpoint: Some(InstanceEndpoint {
                base_url: "https://pvs.tailnet.ts.net:8787".into(),
                secret: Some("sekrit".into()),
            }),
            start_cmd: None,
            tailscale: Some(InstanceTailscale {
                node: "pvs".into(),
                fqdn: Some("pvs.tailnet.ts.net".into()),
            }),
            created_at: String::new(),
            updated_at: String::new(),
            session: String::new(),
            user_id: String::new(),
            secret: None,
            has_secret: false,
            pid: None,
        };
        let json = serde_json::to_string(&inst).unwrap();
        let back: KlankerInstance = serde_json::from_str(&json).unwrap();
        assert_eq!(back.kind, InstanceKind::Remote);
        assert_eq!(
            back.endpoint.unwrap().base_url,
            "https://pvs.tailnet.ts.net:8787"
        );
    }
}
