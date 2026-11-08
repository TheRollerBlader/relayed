"""Live synthetic entitlement probes. Outputs statuses only, never credentials/media."""
import asyncio, base64, io, json, os, time, wave
from pathlib import Path
from dotenv import load_dotenv
import httpx
from PIL import Image, ImageDraw
load_dotenv(Path(__file__).resolve().parents[1] / '.env')
results = {}
async def models():
    headers={'Authorization':'Bearer '+os.environ['NVIDIA_API_KEY']}
    img=Image.new('RGB',(320,200),'white'); ImageDraw.Draw(img).text((25,80),'SYNTHETIC WATER STATION',fill='black')
    b=io.BytesIO();img.save(b,format='PNG')
    async with httpx.AsyncClient(timeout=45) as client:
        for name,model,content in [('language',os.environ['NEMOTRON_MODEL'],'Reply with exactly: RelayAid synthetic test.'),('vision',os.environ['VISION_MODEL'],[{'type':'text','text':'Read the text in this synthetic image.'},{'type':'image_url','image_url':{'url':'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()}}])]:
            try:
                r=await client.post(os.environ['NEMOTRON_BASE_URL']+'/chat/completions',headers=headers,json={'model':model,'messages':[{'role':'user','content':content}],'max_tokens':300})
                content=r.json().get('choices',[{}])[0].get('message',{}).get('content','') if r.is_success else ''
                results[name]={'status':r.status_code,'passed':bool(content),'syntheticResponse':content[:350]}
            except Exception as e: results[name]={'passed':False,'errorType':type(e).__name__}
def speech():
    import riva.client
    from riva.client.proto import riva_asr_pb2 as asr, riva_tts_pb2 as tts
    metadata=lambda function:[('function-id',function),('authorization','Bearer '+os.environ['NVIDIA_API_KEY'])]
    try:
        auth=riva.client.Auth(uri='grpc.nvcf.nvidia.com:443',use_ssl=True,metadata_args=metadata('877104f7-e885-42b9-8de8-f6e4c6303969'))
        service=riva.client.SpeechSynthesisService(auth)
        request=tts.SynthesizeSpeechRequest(text='This is a synthetic test. I need fourteen bottles of water.',language_code='en-US',encoding=riva.client.AudioEncoding.LINEAR_PCM,sample_rate_hz=16000,voice_name='Magpie-Multilingual.EN-US.Leo')
        audio=service.stub.Synthesize(request,metadata=auth.get_auth_metadata(),timeout=45).audio
        results['tts']={'passed':len(audio)>0,'bytes':len(audio)}
    except Exception as e:
        results['tts']={'passed':False,'errorType':type(e).__name__,'code':str(e.code()) if hasattr(e,'code') else ''}; audio=b'\0'*32000
    try:
        auth=riva.client.Auth(uri='grpc.nvcf.nvidia.com:443',use_ssl=True,metadata_args=metadata('bb0837de-8c7b-481f-9ec8-ef5663e9c1fa'))
        service=riva.client.ASRService(auth)
        config=asr.RecognitionConfig(encoding=riva.client.AudioEncoding.LINEAR_PCM,sample_rate_hertz=16000,language_code='en-US',max_alternatives=1,enable_automatic_punctuation=True)
        def requests():
            yield asr.StreamingRecognizeRequest(streaming_config=asr.StreamingRecognitionConfig(config=config,interim_results=True))
            for i in range(0,len(audio),3200):yield asr.StreamingRecognizeRequest(audio_content=audio[i:i+3200])
        replies=service.stub.StreamingRecognize(requests(),metadata=auth.get_auth_metadata(),timeout=45)
        transcripts=[r.alternatives[0].transcript for response in replies for r in response.results if r.is_final and r.alternatives]
        results['asr']={'passed':bool(transcripts) and results['tts']['passed'],'syntheticTranscript':' '.join(transcripts)}
    except Exception as e:results['asr']={'passed':False,'errorType':type(e).__name__,'code':str(e.code()) if hasattr(e,'code') else ''}
async def main():
    await asyncio.gather(models(),asyncio.to_thread(speech))
    output={'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'live':True,'results':results}
    Path('artifacts').mkdir(exist_ok=True);Path('artifacts/nvidia-smoke.json').write_text(json.dumps(output,indent=2));print(json.dumps(output,indent=2))
asyncio.run(main())
