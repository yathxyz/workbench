//! Strict, non-coercing validation of ACP v1 session configuration option lists.

use serde_json::Value;

/// Validates the complete list before it can replace the last known good state.
/// ACP 1.11.0 permits either flat choices or groups, not a mixture of both.
/// Unlike the schema's tolerant deserializer, invalid items are never discarded.
pub(super) fn valid_options(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|options| options.iter().all(valid_option))
}

fn valid_option(option: &Value) -> bool {
    option.get("id").is_some_and(Value::is_string)
        && option.get("name").is_some_and(Value::is_string)
        && optional(option, "description", Value::is_string)
        && optional(option, "category", Value::is_string)
        && optional(option, "_meta", Value::is_object)
        && match option.get("type").and_then(Value::as_str) {
            Some("boolean") => option.get("currentValue").is_some_and(Value::is_boolean),
            Some("select") => {
                option.get("currentValue").is_some_and(Value::is_string)
                    && option
                        .get("options")
                        .and_then(Value::as_array)
                        .is_some_and(|options| {
                            options.iter().all(valid_choice) || options.iter().all(valid_group)
                        })
            }
            _ => false,
        }
}

fn valid_choice(choice: &Value) -> bool {
    choice.get("value").is_some_and(Value::is_string)
        && choice.get("name").is_some_and(Value::is_string)
        && optional(choice, "description", Value::is_string)
        && optional(choice, "_meta", Value::is_object)
}

fn valid_group(group: &Value) -> bool {
    group.get("group").is_some_and(Value::is_string)
        && group.get("name").is_some_and(Value::is_string)
        && group
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| options.iter().all(valid_choice))
        && optional(group, "_meta", Value::is_object)
}

/// Optional schema fields accept both omission and null. Unknown fields remain
/// untouched for ACP extensibility, including arbitrary values inside `_meta`.
fn optional(value: &Value, field: &str, valid: fn(&Value) -> bool) -> bool {
    value
        .get(field)
        .is_none_or(|value| value.is_null() || valid(value))
}

#[cfg(test)]
mod tests {
    use agent_client_protocol_schema::v1::SessionConfigOption;
    use serde_json::json;

    use super::*;

    fn boolean() -> Value {
        json!({"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": false})
    }

    fn select(options: Value) -> Value {
        json!({"id": "model", "name": "Model", "type": "select", "currentValue": "small", "options": options})
    }

    fn choice() -> Value {
        json!({"value": "small", "name": "Small"})
    }

    fn group() -> Value {
        json!({"group": "local", "name": "Local", "options": [choice()]})
    }

    fn assert_invalid(option: Value) {
        let options = json!([option]);
        assert!(!valid_options(&options), "accepted {options}");
    }

    #[test]
    fn complete_boolean_flat_grouped_and_empty_lists_are_valid() {
        for options in [
            json!([]),
            json!([boolean()]),
            json!([{"id": "", "name": "", "type": "boolean", "currentValue": true}]),
            json!([select(json!([]))]),
            json!([select(
                json!([choice(), {"value": "large", "name": "Large"}])
            )]),
            json!([select(
                json!([group(), {"group": "cloud", "name": "Cloud", "options": []}])
            )]),
            json!([
                boolean(),
                select(json!([choice()])),
                select(json!([group()]))
            ]),
            // The schema constrains types, not membership or nonempty strings.
            json!([{"id": "", "name": "", "type": "select", "currentValue": "", "options": []}]),
        ] {
            assert!(valid_options(&options), "rejected {options}");
            serde_json::from_value::<Vec<SessionConfigOption>>(options).unwrap();
        }
    }

    #[test]
    fn nullable_optional_fields_categories_and_extensions_are_valid() {
        let options = json!([
            {"id": "thinking", "name": "Thinking", "type": "boolean", "currentValue": true,
             "description": null, "category": null, "_meta": null, "_extension": [null, 1]},
            {"id": "model", "name": "Model", "type": "select", "currentValue": "small",
             "description": "Choose a model", "category": "_custom", "_meta": {"arbitrary": [null, 1, false]},
             "options": [{"value": "small", "name": "Small", "description": "Local", "_meta": {"x": null}}]},
            {"id": "effort", "name": "Effort", "type": "select", "currentValue": "low",
             "description": null, "category": "unknown-future-category", "_meta": {},
             "options": [{"group": "levels", "name": "Levels", "_meta": null, "options": [
                 {"value": "low", "name": "Low", "description": null, "_meta": null},
                 {"value": "high", "name": "High", "_meta": {"nested": {"x": true}}}
             ]}]}
        ]);
        assert!(valid_options(&options));
        serde_json::from_value::<Vec<SessionConfigOption>>(options).unwrap();
    }

    #[test]
    fn lists_require_every_item_to_be_an_option_object() {
        for options in [
            json!(null),
            json!(false),
            json!(7),
            json!("options"),
            json!({}),
            json!([null]),
            json!([false]),
            json!([7]),
            json!(["option"]),
            json!([[]]),
            json!([{}]),
            json!([boolean(), null]),
            json!([null, boolean()]),
        ] {
            assert!(!valid_options(&options), "accepted {options}");
        }
    }

    #[test]
    fn option_identifiers_names_and_supported_types_are_required() {
        for base in [boolean(), select(json!([choice()]))] {
            for field in ["id", "name", "type"] {
                let mut option = base.clone();
                option.as_object_mut().unwrap().remove(field);
                assert_invalid(option);
                for value in [json!(null), json!(false), json!(1), json!([]), json!({})] {
                    let mut option = base.clone();
                    option[field] = value;
                    assert_invalid(option);
                }
            }
            for kind in ["", "string", "Boolean", "SELECT"] {
                let mut option = base.clone();
                option["type"] = json!(kind);
                assert_invalid(option);
            }
        }
    }

    #[test]
    fn current_values_must_match_the_option_type() {
        for base in [boolean(), select(json!([choice()]))] {
            let mut missing = base.clone();
            missing.as_object_mut().unwrap().remove("currentValue");
            assert_invalid(missing);
            for value in [json!(null), json!(1), json!([]), json!({})] {
                let mut option = base.clone();
                option["currentValue"] = value;
                assert_invalid(option);
            }
        }
        let mut option = boolean();
        option["currentValue"] = json!("false");
        assert_invalid(option);
        let mut option = select(json!([choice()]));
        option["currentValue"] = json!(false);
        assert_invalid(option);
    }

    #[test]
    fn select_options_require_complete_homogeneous_choices_or_groups() {
        let mut missing = select(json!([]));
        missing.as_object_mut().unwrap().remove("options");
        assert_invalid(missing);
        for options in [
            json!(null),
            json!(false),
            json!(1),
            json!("choices"),
            json!({}),
            json!([null]),
            json!([false]),
            json!([1]),
            json!(["small"]),
            json!([[]]),
            json!([{}]),
            json!([choice(), null]),
            json!([group(), null]),
            json!([choice(), group()]),
            json!([group(), choice()]),
        ] {
            assert_invalid(select(options));
        }
        for base in [choice(), group()] {
            let id = if base.get("value").is_some() {
                "value"
            } else {
                "group"
            };
            for field in [id, "name"] {
                let mut item = base.clone();
                item.as_object_mut().unwrap().remove(field);
                assert_invalid(select(json!([item])));
                for value in [json!(null), json!(false), json!(1), json!([]), json!({})] {
                    let mut item = base.clone();
                    item[field] = value;
                    assert_invalid(select(json!([item])));
                }
            }
        }
    }

    #[test]
    fn groups_require_an_array_of_complete_non_nested_choices() {
        let mut missing = group();
        missing.as_object_mut().unwrap().remove("options");
        assert_invalid(select(json!([missing])));
        for options in [
            json!(null),
            json!(false),
            json!(1),
            json!("choices"),
            json!({}),
            json!([null]),
            json!([{}]),
            json!([{"value": "small"}]),
            json!([{"name": "Small"}]),
            json!([{"value": 1, "name": "Small"}]),
            json!([{"value": "small", "name": false}]),
            json!([choice(), null]),
            json!([group()]),
        ] {
            let mut item = group();
            item["options"] = options;
            assert_invalid(select(json!([item])));
        }
    }

    #[test]
    fn optional_fields_are_checked_in_options_choices_and_groups() {
        for base in [boolean(), select(json!([choice()]))] {
            for field in ["description", "category"] {
                for value in [json!(false), json!(1), json!([]), json!({})] {
                    let mut option = base.clone();
                    option[field] = value;
                    assert_invalid(option);
                }
            }
        }
        for value in [json!(false), json!(1), json!([]), json!({})] {
            let mut item = choice();
            item["description"] = value;
            assert_invalid(select(json!([item.clone()])));
            let mut grouped = group();
            grouped["options"] = json!([item]);
            assert_invalid(select(json!([grouped])));
        }
        for value in [json!(false), json!(1), json!("metadata"), json!([])] {
            let mut option = boolean();
            option["_meta"] = value.clone();
            assert_invalid(option);
            let mut option = select(json!([choice()]));
            option["_meta"] = value.clone();
            assert_invalid(option);
            let mut item = choice();
            item["_meta"] = value.clone();
            assert_invalid(select(json!([item.clone()])));
            let mut grouped = group();
            grouped["options"] = json!([item]);
            assert_invalid(select(json!([grouped])));
            let mut grouped = group();
            grouped["_meta"] = value;
            assert_invalid(select(json!([grouped])));
        }
    }
}
