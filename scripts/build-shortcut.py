"""Build a bounded, bulk Health export. No per-sample Repeat actions."""
from pathlib import Path
import plistlib
import uuid

ROOT = Path(__file__).resolve().parents[1]
actions = []

def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'https://github.com/ybivashhka/runlog/health-v2/' + name)).upper()

def ref(value):
    return {'Value': value, 'WFSerializationType': 'WFTextTokenAttachment'}

def text(value):
    if isinstance(value, str):
        return value
    return {'Value': {'string': '\ufffc', 'attachmentsByRange': {'{0, 1}': value}},
            'WFSerializationType': 'WFTextTokenString'}

def action(name, kind, **params):
    key = uid(name)
    actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + kind,
                    'WFWorkflowActionParameters': {'UUID': key, **params}})
    return {'Type': 'ActionOutput', 'OutputUUID': key, 'OutputName': {
        'filter.health.quantity': 'Health Samples', 'format.date': 'Formatted Date',
        'properties.health.quantity': 'Details of Health Samples',
        'text.combine': 'Combined Text', 'count': 'Count', 'dictionary': 'Dictionary',
        'gettext': 'Text', 'setitemname': 'Renamed Item',
    }.get(kind, name)}

def dictionary(name, fields):
    # Native dictionary -> text performs JSON escaping, including source names.
    return action(name, 'dictionary', WFItems={'Value': {'WFDictionaryFieldValueItems': [
        {'WFItemType': 0, 'WFKey': key, 'WFValue': text(value)} for key, value in fields.items()
    ]}, 'WFSerializationType': 'WFDictionaryFieldValue'})

action('comment', 'comment', WFCommentActionText=
       'RUNLOG Health Sync v2\nToday only. Two bounded queries, no per-sample loops. '
       'Reads Steps and Walking + Running Distance. Saves runlog-health.json to iCloud Drive/Shortcuts. '
       'Does not write to Health. Compare the first import with Health.')
generated = action('generated', 'format.date', WFDate=ref({'Type': 'CurrentDate'}),
                   WFDateFormatStyle='Custom', WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXXXX", WFLocale='en_US_POSIX')
fields = {'format': 'runlog-health-v2', 'generatedAt': generated, 'sampleLimit': '2000'}
for kind, label in [('steps', 'Steps'), ('distance', 'Walking + Running Distance')]:
    samples = action(kind + '-find', 'filter.health.quantity', WFContentItemFilter={
        'Value': {'WFActionParameterFilterPrefix': 1, 'WFContentPredicateBoundedDate': False,
                  'WFActionParameterFilterTemplates': [
            {'Bounded': True, 'Operator': 4, 'Property': 'Type', 'Removable': False,
             'Values': {'Enumeration': {'Value': label, 'WFSerializationType': 'WFStringSubstitutableState'}}},
            {'Bounded': True, 'Operator': 1002, 'Property': 'Start Date', 'Removable': True,
             'Values': {'Number': '7', 'Unit': 16}},
        ]}, 'WFSerializationType': 'WFContentPredicateTableTemplate'},
        WFContentItemLimitEnabled=True, WFContentItemLimitNumber=2000)
    fields[kind + 'Count'] = action(kind + '-count', 'count', WFCountType='Items', Input=ref(samples))
    for name, detail in [('start', 'Start Date'), ('end', 'End Date'), ('value', 'Value'), ('unit', 'Unit'), ('source', 'Source')]:
        values = action(kind + '-' + name, 'properties.health.quantity',
                        WFContentItemPropertyName=detail, WFInput=ref(samples))
        if name in ('start', 'end'):
            values = action(kind + '-' + name + '-iso', 'format.date', WFDate=ref(values),
                            WFDateFormatStyle='Custom', WFDateFormat="yyyy-MM-dd'T'HH:mm:ssXXXXX", WFLocale='en_US_POSIX')
        fields[kind + '_' + name] = action(kind + '-' + name + '-lines', 'text.combine',
                                          text=ref(values), WFTextSeparator='New Lines')
body = dictionary('envelope', fields)
serialized = action('json', 'gettext', WFTextActionText=text(body))
file = action('filename', 'setitemname', WFInput=ref(serialized), WFName='runlog-health.json')
action('save', 'documentpicker.save', WFInput=ref(file), WFAskWhereToSave=False,
       WFFileDestinationPath='runlog-health.json', WFSaveFileOverwrite=True)
action('done', 'notification', WFNotificationActionTitle='RUNLOG',
       WFNotificationActionBody='Activity export saved to iCloud Drive/Shortcuts.', WFNotificationActionSound=False)
workflow = {'WFWorkflowActions': actions, 'WFWorkflowName': 'RUNLOG Health Sync',
    'WFWorkflowClientVersion': '2600', 'WFWorkflowClientRelease': '26.0',
    'WFWorkflowMinimumClientVersion': 900, 'WFWorkflowMinimumClientVersionString': '900',
    'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 59711, 'WFWorkflowIconStartColor': 431817727},
    'WFWorkflowHasOutputFallback': False, 'WFWorkflowImportQuestions': [],
    'WFWorkflowOutputContentItemClasses': [], 'WFWorkflowInputContentItemClasses': [],
    'WFWorkflowTypes': [], 'WFWorkflowIsDisabledOnLockScreen': True}
(ROOT/'shortcuts/RUNLOG Health Sync.plist').write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False))
(ROOT/'shortcuts/RUNLOG Health Sync.unsigned.shortcut').write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
print(f'{len(actions)} actions; today only; 2000-sample safety cap per metric; no Repeat actions')
