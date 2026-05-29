import { useState, useEffect } from 'react';
import { browser } from 'wxt/browser';
import { QueueItem, ScriptData, ScriptScene } from '../../utils/types';
import { parseImagePromptToText } from '../../utils/parser';
import './App.css';

function App() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState('');
  const [parsedScenes, setParsedScenes] = useState<{scene_number: number, prompt: string}[]>([]);
  const [fileName, setFileName] = useState<string>('');

  useEffect(() => {
    browser.runtime.sendMessage({ type: 'GET_QUEUE' }).then(res => {
      if (res && res.queue) {
        setQueue(res.queue);
      }
    });

    const listener = (message: any) => {
      if (message.type === 'QUEUE_UPDATED') {
        setQueue(message.queue);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string) as ScriptData;
        if (!json.scenes || !Array.isArray(json.scenes)) {
          setError('El archivo JSON no tiene el formato esperado (falta el array "scenes").');
          return;
        }
        
        const prepared = json.scenes.map(scene => ({
          scene_number: scene.scene_number,
          prompt: parseImagePromptToText(scene.image_prompt)
        }));
        
        setParsedScenes(prepared);
        setError('');
      } catch (err) {
        console.error(err);
        setError('Error al leer el archivo JSON.');
      }
    };
    reader.readAsText(file);
  };

  const handleStartQueue = async () => {
    if (parsedScenes.length === 0) {
      setError('Por favor, sube un archivo JSON primero.');
      return;
    }

    setError('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.id) {
        setError('Error: No active tab found.');
        return;
      }

      await browser.runtime.sendMessage({
        type: 'START_QUEUE',
        prompts: parsedScenes,
        tabId: tab.id
      });
      
      setParsedScenes([]);
      setFileName('');
      // Reset input file value if needed, but react handles it okay if re-mounted
    } catch (err) {
      console.error(err);
      setError('Error al comunicar con la extensión.');
    }
  };

  const handleClearQueue = async () => {
    await browser.runtime.sendMessage({ type: 'CLEAR_QUEUE' });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING': return '#fbbc04';
      case 'IN_PROGRESS': return '#4285f4';
      case 'DOWNLOADED': return '#34a853';
      case 'ERROR': return '#ea4335';
      default: return '#5f6368';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'PENDING': return '⏳';
      case 'IN_PROGRESS': return '⚙️';
      case 'DOWNLOADED': return '✅';
      case 'ERROR': return '❌';
      default: return '❓';
    }
  };

  const totalItems = queue.length;
  const downloadedItems = queue.filter(q => q.status === 'DOWNLOADED').length;
  const progressPercent = totalItems > 0 ? Math.round((downloadedItems / totalItems) * 100) : 0;

  return (
    <div style={{ padding: '16px', width: '380px', display: 'flex', flexDirection: 'column', gap: '16px', fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: '18px', color: '#1a73e8' }}>Flow Script Processor</h2>
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px dashed #dadce0' }}>
        <p style={{ margin: 0, fontSize: '12px', color: '#5f6368', fontWeight: '500' }}>
          1. Sube tu archivo script.json
        </p>
        <input 
          type="file" 
          accept=".json" 
          onChange={handleFileUpload}
          style={{ fontSize: '12px' }}
        />
        
        {parsedScenes.length > 0 && (
          <div style={{ fontSize: '12px', color: '#1e8e3e', fontWeight: 'bold' }}>
            ✓ Archivo cargado: {fileName} ({parsedScenes.length} escenas detectadas)
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <button 
            onClick={handleStartQueue}
            disabled={parsedScenes.length === 0}
            style={{
              flex: 1,
              backgroundColor: parsedScenes.length === 0 ? '#dadce0' : '#1a73e8',
              color: parsedScenes.length === 0 ? '#5f6368' : 'white',
              border: 'none',
              padding: '10px 16px',
              borderRadius: '20px',
              cursor: parsedScenes.length === 0 ? 'not-allowed' : 'pointer',
              fontWeight: '500',
              transition: 'background-color 0.2s'
            }}
          >
            Iniciar Generación
          </button>
          
          <button 
            onClick={handleClearQueue}
            style={{
              backgroundColor: '#fff',
              color: '#ea4335',
              border: '1px solid #ea4335',
              padding: '10px 16px',
              borderRadius: '20px',
              cursor: 'pointer',
              fontWeight: '500'
            }}
          >
            Limpiar Cola
          </button>
        </div>
      </div>

      {error && (
        <p style={{ margin: 0, fontSize: '12px', color: '#d93025', textAlign: 'center' }}>
          {error}
        </p>
      )}

      {/* Barra de Progreso */}
      {totalItems > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#5f6368', fontWeight: 'bold' }}>
            <span>Progreso General</span>
            <span>{downloadedItems} / {totalItems} ({progressPercent}%)</span>
          </div>
          <div style={{ height: '8px', width: '100%', backgroundColor: '#e8eaed', borderRadius: '4px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progressPercent}%`, backgroundColor: '#34a853', transition: 'width 0.3s ease' }}></div>
          </div>
        </div>
      )}

      {/* Cola de Trabajo */}
      <div style={{ borderTop: '1px solid #eee', paddingTop: '12px' }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#3c4043' }}>Detalle de Escenas</h3>
        
        {queue.length === 0 ? (
          <p style={{ fontSize: '12px', color: '#9aa0a6', fontStyle: 'italic' }}>No hay escenas en procesamiento.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '250px', overflowY: 'auto' }}>
            {queue.map((item) => (
              <div 
                key={item.id} 
                style={{ 
                  display: 'flex', 
                  alignItems: 'flex-start', 
                  gap: '8px',
                  padding: '8px',
                  backgroundColor: '#f8f9fa',
                  borderRadius: '6px',
                  borderLeft: `4px solid ${getStatusColor(item.status)}`
                }}
              >
                <span title={item.status} style={{ marginTop: '2px' }}>{getStatusIcon(item.status)}</span>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <span style={{ fontSize: '11px', color: '#5f6368', fontWeight: 'bold' }}>
                    Escena {item.scene_number} - {item.status}
                  </span>
                  <span style={{ 
                    fontSize: '11px', 
                    color: '#202124',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    marginTop: '4px',
                    maxHeight: '40px',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical'
                  }}>
                    {item.prompt}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
