// Experimental per-command MCP tools for `auv mcp serve --tool-exposure typed`.
//
// Each registry command becomes one tool with typed arguments. A call maps
// onto the same `InvokeToolRequest` the compact `invoke` tool takes, so both
// exposures share one execution, recording, and receipt path.
//
// TODO(mcp-typed-tools): provisional surface for the MCP tool exposure
// benchmark. The default stays compact until the owner accepts a result.
// Per-command `outputSchema` is not emitted yet; command results have no
// declared schema to publish.

use std::any::TypeId;

use clap::{Arg, ArgAction};

use super::*;

/// Commands whose receipts are captures, so their tools carry the pixel-to-screen rule.
///
/// NOTICE: The registry declares no artifact kinds. Keep this list in step with
/// the captures `POINTS_NOTE` names.
const CAPTURE_COMMANDS: &[&str] = &["display.capture", "window.capture", "screen.captureRegion"];

/// The MCP tool name of one registry command.
///
/// NOTICE: Command ids contain `.`, which the Anthropic API rejects in tool
/// names (`^[a-zA-Z0-9_-]{1,64}$`). Ids have one dot, so the mapping is reversible.
pub(super) fn tool_name(command_id: &str) -> String {
  command_id.replace('.', "_")
}

/// One typed tool per registry command, in registry order.
pub(super) fn tools(registry: &InvokeRegistry) -> Vec<rmcp::model::Tool> {
  registry
    .all()
    .iter()
    .map(|command| rmcp::model::Tool::new(tool_name(command.id), description(registry, command), Arc::new(input_schema(command))))
    .collect()
}

/// Maps one typed tool call onto the compact `invoke` request, or `None` when
/// `name` is not a typed command tool.
pub(super) fn invoke_request(registry: &InvokeRegistry, name: &str, arguments: Option<JsonObject>) -> Option<Result<InvokeToolRequest, McpError>> {
  let command = registry.all().iter().find(|command| tool_name(command.id) == name)?;
  Some(request_for(command, arguments.unwrap_or_default()))
}

fn request_for(command: &InvokeCommand, mut arguments: JsonObject) -> Result<InvokeToolRequest, McpError> {
  let device_name = take_string(&mut arguments, "device_name")?;
  let device_id = take_string(&mut arguments, "device_id")?;
  let target = match arguments.remove("target") {
    None | Some(Value::Null) => McpInvokeTarget::default(),
    Some(value) => serde_json::from_value(value).map_err(|error| invalid_params(format!("target: {error}")))?,
  };
  // Undeclared keys pass through, so the registry rejects them exactly as it
  // does for compact `inputs`.
  let inputs = arguments
    .into_iter()
    .filter(|(_, value)| !value.is_null())
    .map(|(key, value)| (key, wire_value(value)))
    .collect();
  Ok(InvokeToolRequest {
    command_id: command.id.to_string(),
    device_name,
    device_id,
    target,
    inputs,
    dry_run: false,
    store_root: None,
  })
}

fn take_string(arguments: &mut JsonObject, key: &str) -> Result<Option<String>, McpError> {
  match arguments.remove(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::String(value)) => Ok(Some(value)),
    Some(_) => Err(invalid_params(format!("{key} must be a string"))),
  }
}

/// Encodes one typed argument in the string-valued `inputs` wire format:
/// strings stay as they are, scalars print, and lists or objects become the
/// JSON text compact callers send.
fn wire_value(value: Value) -> String {
  match value {
    Value::String(text) => text,
    other => other.to_string(),
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScalarKind {
  Boolean,
  Integer,
  Number,
  Text,
}

/// The JSON type of one argument value, from its Clap action and value parser.
fn scalar_kind(argument: &Arg) -> ScalarKind {
  if matches!(argument.get_action(), ArgAction::SetTrue | ArgAction::SetFalse) {
    return ScalarKind::Boolean;
  }
  let id = argument.get_value_parser().type_id();
  let integers = [
    TypeId::of::<i8>(),
    TypeId::of::<i16>(),
    TypeId::of::<i32>(),
    TypeId::of::<i64>(),
    TypeId::of::<isize>(),
    TypeId::of::<u8>(),
    TypeId::of::<u16>(),
    TypeId::of::<u32>(),
    TypeId::of::<u64>(),
    TypeId::of::<usize>(),
  ];
  if id == TypeId::of::<bool>() {
    ScalarKind::Boolean
  } else if integers.iter().any(|integer| id == *integer) {
    ScalarKind::Integer
  } else if id == TypeId::of::<f32>() || id == TypeId::of::<f64>() {
    ScalarKind::Number
  } else {
    ScalarKind::Text
  }
}

/// Whether the wire value is a JSON array string (repeated or multi-value arguments).
fn is_list(argument: &Arg) -> bool {
  matches!(argument.get_action(), ArgAction::Append) || argument.get_num_args().is_some_and(|range| range.max_values() > 1)
}

fn scalar_schema(argument: &Arg, kind: ScalarKind) -> JsonObject {
  let mut schema = JsonObject::new();
  let type_name = match kind {
    ScalarKind::Boolean => "boolean",
    ScalarKind::Integer => "integer",
    ScalarKind::Number => "number",
    ScalarKind::Text => "string",
  };
  schema.insert("type".to_string(), Value::String(type_name.to_string()));
  let choices = argument.get_possible_values();
  if kind == ScalarKind::Text && !choices.is_empty() {
    schema.insert(
      "enum".to_string(),
      Value::Array(choices.iter().map(|choice| Value::String(choice.get_name().to_string())).collect()),
    );
  }
  schema
}

/// Parses one wire value back into its typed JSON form, for examples and defaults.
fn typed_value(argument: &Arg, raw: &str) -> Value {
  if is_list(argument) {
    return serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
  }
  match scalar_kind(argument) {
    ScalarKind::Boolean => raw.parse::<bool>().map(Value::Bool).unwrap_or_else(|_| Value::String(raw.to_string())),
    ScalarKind::Integer => raw.parse::<i64>().map(Value::from).unwrap_or_else(|_| Value::String(raw.to_string())),
    ScalarKind::Number => raw.parse::<f64>().ok().and_then(|number| serde_json::Number::from_f64(number).map(Value::Number)).unwrap_or_else(|| Value::String(raw.to_string())),
    ScalarKind::Text => Value::String(raw.to_string()),
  }
}

fn input_schema(command: &InvokeCommand) -> JsonObject {
  let mut properties = JsonObject::new();
  let mut required = Vec::new();
  for argument in command.input_arguments() {
    let key = auv_cli_invoke::command::input_key(&argument);
    let kind = scalar_kind(&argument);
    let mut schema = if is_list(&argument) {
      let mut list = JsonObject::new();
      list.insert("type".to_string(), Value::String("array".to_string()));
      list.insert("items".to_string(), Value::Object(scalar_schema(&argument, kind)));
      list
    } else {
      scalar_schema(&argument, kind)
    };
    if let Some(help) = argument.get_help() {
      schema.insert("description".to_string(), Value::String(help.to_string()));
    }
    if !is_list(&argument)
      && kind != ScalarKind::Boolean
      && let Some(default) = argument.get_default_values().first()
    {
      schema.insert("default".to_string(), typed_value(&argument, &default.to_string_lossy()));
    }
    if argument.is_required_set() {
      required.push(Value::String(key.clone()));
    }
    properties.insert(key, Value::Object(schema));
  }
  if command.target != auv_cli_invoke::command::TargetPolicy::Forbidden {
    properties.insert("target".to_string(), target_schema(command.target));
    if command.target.required() {
      required.push(Value::String("target".to_string()));
    }
  }
  // The Device fields keep the compact `invoke` field descriptions.
  let invoke_schema = rmcp::handler::server::common::cached_schema_for_type::<InvokeToolRequest>();
  if let Some(invoke_properties) = invoke_schema.get("properties").and_then(Value::as_object) {
    for field in ["device_name", "device_id"] {
      if let Some(schema) = invoke_properties.get(field) {
        properties.insert(field.to_string(), schema.clone());
      }
    }
  }
  let mut schema = JsonObject::new();
  schema.insert("type".to_string(), Value::String("object".to_string()));
  schema.insert("properties".to_string(), Value::Object(properties));
  schema.insert("required".to_string(), Value::Array(required));
  schema.insert("additionalProperties".to_string(), Value::Bool(false));
  schema
}

fn target_schema(policy: auv_cli_invoke::command::TargetPolicy) -> Value {
  let mut fields = JsonObject::new();
  for kind in policy.accepted_types() {
    let (field, what) = match *kind {
      "application" => ("application_id", "Application id"),
      "window" => ("window_id", "Window id from window_list"),
      _ => ("display_id", "Display id from display_list"),
    };
    fields.insert(field.to_string(), serde_json::json!({ "type": "string", "description": what }));
  }
  serde_json::json!({
    "type": "object",
    "description": format!("{} Set at most one field.", policy.help()),
    "properties": fields,
    "additionalProperties": false,
  })
}

/// Rewrites guidance written for the compact catalog: `inputs.<key>` becomes the
/// top-level argument `<key>`, and command ids become tool names.
fn typed_text(registry: &InvokeRegistry, text: &str) -> String {
  let mut text = text.replace("`inputs.", "`");
  for command in registry.all() {
    text = text.replace(&format!("`{}`", command.id), &format!("`{}`", tool_name(command.id)));
  }
  text
}

fn description(registry: &InvokeRegistry, command: &InvokeCommand) -> String {
  let mut text = command.description.to_string();
  match command.role {
    auv_cli_invoke::CommandRole::Desktop => {}
    auv_cli_invoke::CommandRole::Alias { canonical } => text.push_str(&format!("\nAlias of `{}`.", tool_name(canonical))),
    auv_cli_invoke::CommandRole::Fixture => text.push_str("\nFixture: processes data you supply; does not control a desktop."),
  }
  text.push_str(&format!("\nsupport: {}", platform_support_summary(command)));
  if let Some(runner) = runner_support_summary(command) {
    text.push_str(&format!("\nrunner support: {runner}"));
  }
  text.push_str(&format!("\n\nEach call records an AUV Run. {SUPPORT_NOTE}"));

  let arguments = command.input_arguments();
  let keys = arguments.iter().map(auv_cli_invoke::command::input_key).collect::<Vec<_>>();
  let mut sections = Vec::new();
  if command.target != auv_cli_invoke::command::TargetPolicy::Forbidden {
    sections.push(APPLICATION_IDS_NOTE);
  }
  if keys.iter().any(|key| key == "x" || key == "start_x") || CAPTURE_COMMANDS.contains(&command.id) {
    sections.push(POINTS_NOTE);
  }
  if keys.iter().any(|key| key == "input-policy") {
    sections.push(INPUT_DELIVERY_NOTE);
  }
  for section in sections {
    text.push_str("\n\n");
    text.push_str(&typed_text(registry, section));
  }

  // A command whose examples do not parse is caught by the registry tests;
  // the description stays usable without them.
  for example in command.examples().unwrap_or_default().iter().take(2) {
    text.push_str(&format!("\nexample: {}", typed_example(&arguments, example)));
  }
  text
}

/// One example as the typed tool arguments a client sends.
fn typed_example(arguments: &[Arg], example: &auv_cli_invoke::InvokeExample) -> Value {
  let mut call = JsonObject::new();
  for (key, raw) in &example.inputs {
    let value = match arguments.iter().find(|argument| &auv_cli_invoke::command::input_key(argument) == key) {
      Some(argument) => typed_value(argument, raw),
      None => Value::String(raw.clone()),
    };
    call.insert(key.clone(), value);
  }
  if let Some(target) = &example.target {
    let (field, id) = match target {
      ExecutionTarget::Application { id } => ("application_id", id),
      ExecutionTarget::Window { id } => ("window_id", id),
      ExecutionTarget::Display { id } => ("display_id", id),
    };
    call.insert("target".to_string(), serde_json::json!({ field: id }));
  }
  Value::Object(call)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn command(id: &str) -> InvokeCommand {
    default_registry().resolve(id).cloned().unwrap_or_else(|| panic!("{id} is registered"))
  }

  #[test]
  fn typed_tools_cover_every_command_with_api_safe_names() {
    let registry = default_registry();
    let tools = tools(&registry);
    assert_eq!(tools.len(), registry.all().len());
    for tool in &tools {
      assert!(tool.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'), "{}", tool.name);
    }
    assert!(tools.iter().all(|tool| tool.name != "invoke"));
  }

  #[test]
  fn typed_call_encodes_the_compact_invoke_inputs() {
    let request = request_for(
      &command("input.clickPoint"),
      serde_json::json!({ "x": 10, "y": 20.5, "normalized": true, "target": { "application_id": "org.gnome.TextEditor" } })
        .as_object()
        .cloned()
        .unwrap(),
    )
    .expect("typed arguments map onto invoke");
    assert_eq!(request.command_id, "input.clickPoint");
    assert_eq!(request.inputs.get("x").map(String::as_str), Some("10"));
    assert_eq!(request.inputs.get("y").map(String::as_str), Some("20.5"));
    assert_eq!(request.inputs.get("normalized").map(String::as_str), Some("true"));
    assert_eq!(request.target.application_id.as_deref(), Some("org.gnome.TextEditor"));
  }

  #[test]
  fn typed_list_arguments_become_json_array_strings() {
    let request = request_for(&command("input.keys"), serde_json::json!({ "keys": ["ctrl", "l"] }).as_object().cloned().unwrap()).unwrap();
    assert_eq!(request.inputs.get("keys").map(String::as_str), Some(r#"["ctrl","l"]"#));
  }

  #[test]
  fn typed_schema_declares_argument_types_and_target() {
    let schema = input_schema(&command("input.clickPoint"));
    let properties = schema["properties"].as_object().unwrap();
    assert_eq!(properties["normalized"]["type"], "boolean");
    assert_eq!(properties["target"]["type"], "object");
    assert!(properties.contains_key("device_id"));
    assert_eq!(schema["additionalProperties"], false);
  }

  #[test]
  fn typed_guidance_names_tools_and_top_level_arguments() {
    let registry = default_registry();
    let text = description(&registry, &command("input.clickPoint"));
    assert!(text.contains("`input-policy` decides"), "{text}");
    assert!(!text.contains("`inputs."), "{text}");
    assert!(!text.contains("`window.list`") && text.contains("`window_list`"), "{text}");
  }
}
