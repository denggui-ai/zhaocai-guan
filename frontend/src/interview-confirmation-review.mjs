function clean(value) {
  return value == null ? '' : String(value).trim();
}

function pick(item, keys) {
  if (!item) return '';
  for (const key of keys) {
    if (clean(item[key])) return item[key];
  }
  return '';
}

function confirmationFieldById(fields, idOrLabel) {
  const text = clean(idOrLabel);
  return (fields || []).find((field) => field.id === text || field.label === text);
}

export function normalizeConfirmationStatus(value) {
  const text = clean(value).toLowerCase();
  if (/corrected|correct|fixed|修正|更正|已修正/.test(text)) return 'corrected';
  if (/confirmed|confirm|done|已确认|确认无误|属实/.test(text)) return 'confirmed';
  if (/unknown|unsure|未知|不确定|无法确认/.test(text)) return 'unknown';
  if (/discarded|discard|ignored|rejected|reject|废弃|作废|忽略|驳回/.test(text)) return 'rejected';
  return 'pending';
}

export function confirmationItemId(item, index, fields = []) {
  const authoritativeKey = pick(item, ['field_key', 'fieldKey']);
  if (clean(authoritativeKey)) {
    const known = confirmationFieldById(fields, authoritativeKey);
    return known ? known.id : clean(authoritativeKey);
  }

  const legacyKey = pick(item, ['field_id', 'fieldId', 'field', 'key', 'category', 'type', 'id']);
  const known = confirmationFieldById(fields, legacyKey)
    || confirmationFieldById(fields, pick(item, ['field_label', 'fieldLabel', 'label', 'title', 'name']));
  return known ? known.id : clean(legacyKey) || `extra_${index}`;
}

export function normalizeSavedConfirmationItem(item, index, fields = []) {
  const id = confirmationItemId(item, index, fields);
  const field = confirmationFieldById(fields, id);
  return {
    id,
    field_key: id,
    label: pick(item, ['field_label', 'fieldLabel', 'label', 'title', 'name']) || (field && field.label) || id,
    status: normalizeConfirmationStatus(pick(item, ['status', 'state'])),
    value: pick(item, ['extracted_value', 'extractedValue', 'value', 'default_value', 'defaultValue', 'raw_value', 'rawValue', 'ai_value', 'aiValue']),
    corrected_value: pick(item, ['corrected_value', 'correctedValue', 'correction', 'fixed_value', 'fixedValue']),
    note: pick(item, ['note', 'notes', 'remark', 'comment']),
    evidence: pick(item, ['evidence', 'source_text', 'sourceText', 'quote', 'reason']),
    source: pick(item, ['source']) || 'saved',
  };
}

export function strictConfirmationReviewItems(items, fields = []) {
  return (items || []).reduce((result, item, index) => {
    const status = normalizeConfirmationStatus(item.status);
    if (status === 'pending') return result;
    result.push({
      field_key: confirmationItemId(item, index, fields),
      status,
      ...(status === 'corrected' ? { corrected_value: clean(item.corrected_value) } : {}),
    });
    return result;
  }, []);
}
