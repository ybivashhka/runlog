"""A bounded, read-only iPhone check. Does not export or change Health data."""
from pathlib import Path
import plistlib
import uuid

root=Path(__file__).resolve().parents[1]
def uid(name):return str(uuid.uuid5(uuid.NAMESPACE_URL,'https://github.com/ybivashhka/runlog/health-check/'+name)).upper()
def output(name,label):return {'Value':{'Type':'ActionOutput','OutputUUID':uid(name),'OutputName':label},'WFSerializationType':'WFTextTokenAttachment'}
def action(name,kind,params):return {'WFWorkflowActionIdentifier':'is.workflow.actions.'+kind,'WFWorkflowActionParameters':{'UUID':uid(name),**params}}
filter_value={'Value':{'WFActionParameterFilterPrefix':1,'WFContentPredicateBoundedDate':False,'WFActionParameterFilterTemplates':[
 {'Bounded':True,'Operator':4,'Property':'Type','Removable':False,'Values':{'Enumeration':{'Value':'Steps','WFSerializationType':'WFStringSubstitutableState'}}},
 {'Bounded':True,'Operator':1002,'Property':'Start Date','Removable':True,'Values':{'Number':'7','Unit':16}},
]},'WFSerializationType':'WFContentPredicateTableTemplate'}
prefix='Health query completed. Samples found (maximum 1): '
actions=[
 action('find','filter.health.quantity',{'WFContentItemFilter':filter_value,'WFContentItemLimitEnabled':True,'WFContentItemLimitNumber':1}),
 action('count','count',{'WFCountType':'Items','Input':output('find','Health Samples')}),
 action('show','showresult',{'Text':{'Value':{'string':prefix+'\ufffc','attachmentsByRange':{'{%d, 1}'%len(prefix):{'Type':'ActionOutput','OutputUUID':uid('count'),'OutputName':'Count'}}},'WFSerializationType':'WFTextTokenString'}}),
]
workflow={'WFWorkflowActions':actions,'WFWorkflowName':'RUNLOG Health Check','WFWorkflowClientVersion':'2600','WFWorkflowClientRelease':'26.0','WFWorkflowMinimumClientVersion':900,'WFWorkflowMinimumClientVersionString':'900','WFWorkflowIcon':{'WFWorkflowIconGlyphNumber':59711,'WFWorkflowIconStartColor':431817727},'WFWorkflowHasOutputFallback':False,'WFWorkflowImportQuestions':[],'WFWorkflowInputContentItemClasses':[],'WFWorkflowOutputContentItemClasses':[],'WFWorkflowTypes':[],'WFWorkflowIsDisabledOnLockScreen':True}
(root/'shortcuts/RUNLOG Health Check.plist').write_bytes(plistlib.dumps(workflow,fmt=plistlib.FMT_XML,sort_keys=False))
(root/'shortcuts/RUNLOG Health Check.unsigned.shortcut').write_bytes(plistlib.dumps(workflow,fmt=plistlib.FMT_BINARY))
print('3 actions; sample limit 1; no repeats, network, file writes or Health writes')
