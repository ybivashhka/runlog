"""Build the read-only iPhone Health → iCloud bridge. No third-party actions."""
from pathlib import Path
import plistlib
import uuid

ROOT = Path(__file__).resolve().parents[1]
actions = []

def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://github.com/ybivashhka/runlog/' + name)).upper()

def action(name, identifier, **params):
    key = uid(name)
    actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier,
                    'WFWorkflowActionParameters': {'UUID': key, **params}})
    return {'Type': 'ActionOutput', 'OutputUUID': key, 'OutputName': {
        'format.date': 'Formatted Date', 'filter.health.quantity': 'Health Samples',
        'dictionary': 'Dictionary', 'gettext': 'Text', 'repeat.each': 'Repeat Results',
        'text.combine': 'Combined Text', 'setitemname': 'Renamed Item'
    }.get(identifier, name)}

def ref(value):
    return {'Value': value, 'WFSerializationType': 'WFTextTokenAttachment'}

def text(*parts):
    result = ''; attachments = {}
    for p in parts:
        if isinstance(p, dict):
            attachments['{%d, 1}' % len(result)] = p
            result += '\ufffc'
        else:
            result += p
    return {'Value': {'string': result, 'attachmentsByRange': attachments}, 'WFSerializationType': 'WFTextTokenString'}

def formatted(name, value):
    return action(name, 'format.date', WFDate=text(value), WFDateFormatStyle='Custom',
                  WFDateFormat='Custom', WFDateFormatString="yyyy-MM-dd'T'HH:mm:ssXXXXX", WFLocale='en_US_POSIX')

action('Comment', 'comment', WFCommentActionText='RUNLOG Health Sync\nRead-only: Steps and Walking + Running Distance for the last 8 days.\nSaves runlog-health.json in iCloud Drive/Shortcuts. No Health records are written.\nAfter the first run, compare the imported steps with Health. An empty export does not mean zero steps.')
generated = formatted('Export time', {'Type': 'CurrentDate'})
outputs = {}
for kind, label in [('steps', 'Steps'), ('distance', 'Walking + Running Distance')]:
    samples = action(kind + '-find', 'filter.health.quantity',
        WFContentItemFilter={'Value': {
            'WFActionParameterFilterPrefix': 1, 'WFContentPredicateBoundedDate': False,
            'WFActionParameterFilterTemplates': [
                {'Bounded': True, 'Operator': 4, 'Property': 'Type', 'Removable': False,
                 'Values': {'Enumeration': {'Value': label, 'WFSerializationType': 'WFStringSubstitutableState'}}},
                {'Bounded': True, 'Operator': 1001, 'Property': 'Start Date', 'Removable': True,
                 'Values': {'Number': 8, 'Unit': 16384}}
            ]}, 'WFSerializationType': 'WFContentPredicateTableTemplate'}, WFContentItemLimitEnabled=False)
    group = uid(kind + '-group')
    action(kind + '-loop-start', 'repeat.each', GroupingIdentifier=group, WFControlFlowMode=0, WFInput=ref(samples))
    item = {'Type': 'Variable', 'VariableName': 'Repeat Item'}
    fields = {}
    for key, detail in [('start', 'Start Date'), ('end', 'End Date'), ('value', 'Value'), ('unit', 'Unit'), ('source', 'Source')]:
        value = action(kind + '-' + key, 'properties.health.quantity', WFContentItemPropertyName=detail, WFInput=ref(item))
        if key in ['start', 'end']:
            value = formatted(kind + '-' + key + '-iso', value)
        fields[key] = value
    dictionary = action(kind + '-record', 'dictionary', WFItems={
        'Value': {'WFDictionaryFieldValueItems': [
            {'WFItemType': 0, 'WFKey': text(key), 'WFValue': text(value)} for key, value in fields.items()
        ]}, 'WFSerializationType': 'WFDictionaryFieldValue'})
    action(kind + '-json', 'gettext', WFTextActionText=text(dictionary))
    results = action(kind + '-loop-end', 'repeat.each', GroupingIdentifier=group, WFControlFlowMode=2)
    outputs[kind] = action(kind + '-join', 'text.combine', text=ref(results), WFTextSeparator='Custom', WFTextCustomSeparator=',')
body = action('Envelope', 'gettext', WFTextActionText=text(
    '{"format":"runlog-health-v1","generatedAt":"', generated,
    '","steps":[', outputs['steps'], '],"distance":[', outputs['distance'], ']}'))
file = action('Filename', 'setitemname', WFInput=ref(body), WFName='runlog-health.json')
action('Save', 'documentpicker.save', WFInput=ref(file), WFAskWhereToSave=False,
       WFFileDestinationPath='runlog-health.json', WFSaveFileOverwrite=True)
workflow = {
    'WFWorkflowActions': actions, 'WFWorkflowName': 'RUNLOG Health Sync',
    'WFWorkflowClientVersion': '2600', 'WFWorkflowClientRelease': '26.0',
    'WFWorkflowMinimumClientVersion': 900, 'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 59711, 'WFWorkflowIconStartColor': 431817727},
    'WFWorkflowHasOutputFallback': False, 'WFWorkflowImportQuestions': [],
    'WFWorkflowOutputContentItemClasses': [], 'WFWorkflowInputContentItemClasses': [],
    'WFWorkflowTypes': [], 'WFWorkflowIsDisabledOnLockScreen': True,
}
output = ROOT / 'shortcuts' / 'RUNLOG Health Sync.plist'
output.write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False))
unsigned = ROOT / 'shortcuts' / 'RUNLOG Health Sync.unsigned.shortcut'
unsigned.write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
print(f'{len(actions)} actions → {output.name}')
