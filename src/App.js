import React, { useState, useEffect } from 'react';
import { Save, Settings, Cloud, CloudOff, Plus, Trash2, HardDrive, FileSpreadsheet, X, Tag, Clock, Scale, AlertTriangle, CheckCircle, XCircle } from 'lucide-react';
import * as XLSX from 'xlsx';

// --- HILFSFUNKTIONEN ---
const safeParse = (key, fallback) => {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch (error) {
    console.warn(`Warnung: Daten für ${key} konnten nicht geladen werden.`, error);
    return fallback;
  }
};

const formatDuration = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
};

const App = () => {
  // --- STATE ---
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Daten
  const [filaments, setFilaments] = useState([]);
  const [prints, setPrints] = useState([]);
  const [materials, setMaterials] = useState(['PLA', 'PLA Matte', 'PETG', 'TPU', 'ABS', 'ASA']);
  const [brands, setBrands] = useState(['Bambulab', 'Esun', 'Sunlu', 'Overture']);
  const [recipients, setRecipients] = useState(['Ich', 'Sónia', 'Marco', 'Geschenk', 'Andere']);
  const [availableTags, setAvailableTags] = useState([]);

  // UI State für Modal
  const [showModal, setShowModal] = useState(false);
  const [currentPrint, setCurrentPrint] = useState(null); // Das Bearbeitungs-Objekt
  const [originalPrintState, setOriginalPrintState] = useState(null); // Für Delta-Berechnung beim Bearbeiten
  const [newTagInput, setNewTagInput] = useState('');

  // Google Drive State
  const [googleClientId, setGoogleClientId] = useState('');
  const [driveFolderId, setDriveFolderId] = useState('');
  const [googleDriveToken, setGoogleDriveToken] = useState(null);
  const [showDriveSettings, setShowDriveSettings] = useState(false);

  // --- INITIALISIERUNG ---
  useEffect(() => {
    loadData();
    loadGoogleDriveSettings();
    handleGoogleCallback();
  }, []);

  const loadData = () => {
    setFilaments(safeParse('filaments', []));
    setMaterials(safeParse('materials', ['PLA', 'PLA Matte', 'PETG']));
    setBrands(safeParse('brands', ['Bambulab']));
    setRecipients(safeParse('recipients', ['Ich', 'Sónia', 'Marco', 'Geschenk', 'Andere']));
    setAvailableTags(safeParse('tags', []));

    // Migration logic
    const printsData = localStorage.getItem('prints');
    if (printsData) {
      try {
        const loadedPrints = JSON.parse(printsData);
        const migratedPrints = loadedPrints.map(print => ({
          ...print,
          rating: print.rating || 0,
          recipient: print.recipient || 'Ich',
          tags: print.tags || [],
          filamentId: print.filamentId || (print.filament ? print.filament.id : null),
          duration: print.duration || 0, // Minuten
          weight: print.weight || 0,
          success: print.success !== undefined ? print.success : true,
          notes: print.notes || ''
        }));
        setPrints(migratedPrints);
        localStorage.setItem('prints', JSON.stringify(migratedPrints));
      } catch (e) { console.error(e); setPrints([]); }
    }
  };

  const loadGoogleDriveSettings = () => {
    const clientId = localStorage.getItem('googleClientId');
    const folderId = localStorage.getItem('driveFolderId');
    const token = localStorage.getItem('googleDriveToken');
    if (clientId) setGoogleClientId(clientId);
    if (folderId) setDriveFolderId(folderId);
    if (token) setGoogleDriveToken(token);
  };

  const saveToLocal = (key, data, setter) => {
    setter(data);
    localStorage.setItem(key, JSON.stringify(data));
  };

  // --- TAG MANAGEMENT ---
  const handleAddTag = () => {
    const trimmed = newTagInput.trim();
    if (!trimmed) return;
    if (!availableTags.includes(trimmed)) {
      const newTagsList = [...availableTags, trimmed];
      saveToLocal('tags', newTagsList, setAvailableTags);
    }
    if (currentPrint && !currentPrint.tags.includes(trimmed)) {
      setCurrentPrint({ ...currentPrint, tags: [...currentPrint.tags, trimmed] });
    }
    setNewTagInput('');
  };

  const handleDeleteGlobalTag = (tagToDelete) => {
    if(!window.confirm(`Tag "${tagToDelete}" löschen?`)) return;
    const newTagsList = availableTags.filter(t => t !== tagToDelete);
    saveToLocal('tags', newTagsList, setAvailableTags);
  };

  // --- DRUCK & BESTANDSLOGIK (Das Herzstück) ---

  const openNewPrintModal = () => {
    const initial = {
      id: null,
      name: '',
      date: new Date().toISOString().split('T')[0],
      duration: 60, // Standard 1h
      weight: 0,
      filamentId: filaments.length > 0 ? filaments[0].id : '',
      rating: 0,
      recipient: 'Ich',
      tags: [],
      success: true,
      notes: ''
    };
    setCurrentPrint(initial);
    setOriginalPrintState(null); // Kein Original, da neu
    setShowModal(true);
  };

  const openEditModal = (print) => {
    setCurrentPrint({ ...print });
    setOriginalPrintState({ ...print }); // Kopie für Vergleich speichern
    setShowModal(true);
  };

  const handleSavePrint = () => {
    if (!currentPrint.name) return alert('Name fehlt!');
    
    // 1. Bestands-Korrektur Logik
    let updatedFilaments = [...filaments];
    
    // Hilfsfunktion zum Finden und Updaten
    const updateFilamentStock = (filId, amountChange) => {
      const idx = updatedFilaments.findIndex(f => f.id == filId);
      if (idx !== -1) {
        updatedFilaments[idx] = {
          ...updatedFilaments[idx],
          weight: updatedFilaments[idx].weight - amountChange // Abziehen (positive amount) oder Hinzufügen (negative amount)
        };
      }
    };

    if (currentPrint.id) {
      // --- BEARBEITUNG (EDIT) ---
      // Logik: Alten Verbrauch rückgängig machen (+), Neuen Verbrauch abziehen (-)
      
      // A. Alten Verbrauch zurückbuchen (falls es nicht fehlgeschlagen war oder wir Bestandsführung immer wollen)
      if (originalPrintState) {
         // Wir buchen das alte Gewicht zurück auf das alte Filament
         updateFilamentStock(originalPrintState.filamentId, -originalPrintState.weight); 
      }
      
      // B. Neuen Verbrauch abziehen
      updateFilamentStock(currentPrint.filamentId, currentPrint.weight);

      // C. Druck Liste updaten
      const updatedPrints = prints.map(p => p.id === currentPrint.id ? currentPrint : p);
      saveToLocal('prints', updatedPrints, setPrints);

    } else {
      // --- NEUER DRUCK (CREATE) ---
      const newPrint = { ...currentPrint, id: Date.now() };
      
      // Bestand abziehen
      updateFilamentStock(newPrint.filamentId, newPrint.weight);
      
      const updatedPrints = [newPrint, ...prints];
      saveToLocal('prints', updatedPrints, setPrints);
    }

    // Filamente speichern
    saveToLocal('filaments', updatedFilaments, setFilaments);
    setShowModal(false);
  };

  const deletePrint = (print) => {
    if(window.confirm('Druck löschen? Der Bestand wird NICHT automatisch zurückgebucht (Sicherheit).')) {
      const updated = prints.filter(p => p.id !== print.id);
      saveToLocal('prints', updated, setPrints);
    }
  };

  // --- FILAMENT ---
  const addFilament = () => {
    const name = prompt("Name des Filaments:");
    if (!name) return;
    const newFilament = { 
      id: Date.now(), 
      name, 
      brand: brands[0], 
      material: materials[0], 
      color: '#000000', 
      weight: 1000, 
      price: 20 
    };
    saveToLocal('filaments', [...filaments, newFilament], setFilaments);
  };

  // --- EXCEL ---
  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();

    // 1. Inventar
    const wsInv = XLSX.utils.json_to_sheet(filaments.map(f => ({
      Name: f.name, Marke: f.brand, Material: f.material, 'Rest (g)': f.weight
    })));
    XLSX.utils.book_append_sheet(wb, wsInv, "Inventar");

    // 2. Drucke
    const wsPrints = XLSX.utils.json_to_sheet(prints.map(p => {
      const fil = filaments.find(f => f.id == p.filamentId);
      return {
        Datum: new Date(p.date).toLocaleDateString(),
        Name: p.name,
        'Dauer (m)': p.duration,
        'Gewicht (g)': p.weight,
        Filament: fil ? fil.name : 'Gelöscht',
        Erfolg: p.success ? 'Ja' : 'Nein',
        Bewertung: p.rating,
        Empfänger: p.recipient
      };
    }));
    XLSX.utils.book_append_sheet(wb, wsPrints, "Drucke");

    XLSX.writeFile(wb, `3D_Druck_Manager_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  // --- GOOGLE DRIVE ---
  const saveGoogleDriveSettings = () => {
    localStorage.setItem('googleClientId', googleClientId);
    localStorage.setItem('driveFolderId', driveFolderId);
    setShowDriveSettings(false);
  };

  const authenticateGoogleDrive = () => {
    const SCOPES = 'https://www.googleapis.com/auth/drive.file';
    const redirectUri = window.location.origin + window.location.pathname;
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent(SCOPES)}`;
    window.location.href = authUrl;
  };

  const handleGoogleCallback = () => {
    if (window.location.hash.includes('access_token')) {
      const token = new URLSearchParams(window.location.hash.substring(1)).get('access_token');
      setGoogleDriveToken(token);
      localStorage.setItem('googleDriveToken', token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  const uploadToGoogleDrive = async (fileName, dataContent) => {
    if (!googleDriveToken) return alert('Bitte verbinden!');
    
    const findFile = async () => {
      try {
        const q = `name = '${fileName}' and '${driveFolderId}' in parents and trashed = false`;
        const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`, {
          headers: { Authorization: `Bearer ${googleDriveToken}` }
        });
        const json = await res.json();
        return json.files && json.files.length > 0 ? json.files[0].id : null;
      } catch (e) { return null; }
    };

    try {
      const existingId = await findFile();
      const url = existingId 
        ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      const method = existingId ? 'PATCH' : 'POST';
      
      const metadata = { name: fileName, mimeType: 'application/json', ...(driveFolderId && !existingId && { parents: [driveFolderId] }) };
      const formData = new FormData();
      formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      formData.append('file', new Blob([JSON.stringify(dataContent)], { type: 'application/json' }));

      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${googleDriveToken}` }, body: formData });
      if (!res.ok) throw new Error(res.statusText);
      alert('✅ Backup erfolgreich!');
    } catch (e) { alert('❌ ' + e.message); }
  };

  // --- UI RENDER ---
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans pb-20">
      
      {/* HEADER */}
      <header className="bg-slate-800 text-white p-4 shadow flex justify-between items-center sticky top-0 z-10">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <HardDrive className="text-blue-400" /> PrintManager Pro
        </h1>
        <div className="flex gap-2">
          <button onClick={exportToExcel} className="p-2 bg-green-600 rounded hover:bg-green-700" title="Excel Export">
            <FileSpreadsheet size={20} />
          </button>
          {googleDriveToken ? (
            <button onClick={() => uploadToGoogleDrive('3d_druck_backup.json', { filaments, prints, materials, tags: availableTags })} className="p-2 bg-blue-600 rounded hover:bg-blue-700">
              <Cloud size={20} />
            </button>
          ) : (
            <button onClick={authenticateGoogleDrive} className="p-2 bg-gray-600 rounded">
              <CloudOff size={20} />
            </button>
          )}
          <button onClick={() => setShowDriveSettings(!showDriveSettings)} className="p-2 hover:bg-slate-700 rounded"><Settings size={20}/></button>
        </div>
      </header>

      {/* DRIVE SETTINGS */}
      {showDriveSettings && (
        <div className="bg-slate-100 p-4 border-b animate-in slide-in-from-top">
          <div className="max-w-md mx-auto flex flex-col gap-2">
            <input value={googleClientId} onChange={e => setGoogleClientId(e.target.value)} placeholder="Client ID" className="p-2 border rounded" />
            <input value={driveFolderId} onChange={e => setDriveFolderId(e.target.value)} placeholder="Folder ID" className="p-2 border rounded" />
            <button onClick={saveGoogleDriveSettings} className="bg-blue-600 text-white p-2 rounded">Speichern</button>
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto p-4">
        {/* TABS */}
        <div className="flex gap-4 mb-6 border-b">
          {['dashboard', 'filaments', 'tags'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`pb-2 px-4 capitalize ${activeTab === tab ? 'border-b-2 border-blue-600 font-bold' : ''}`}>{tab}</button>
          ))}
        </div>

        {/* --- DASHBOARD (PRINTS) --- */}
        {activeTab === 'dashboard' && (
          <div>
            <button onClick={openNewPrintModal} className="w-full bg-blue-600 text-white py-3 rounded-lg shadow mb-4 flex justify-center items-center gap-2 font-bold hover:bg-blue-700 transition">
              <Plus /> Neuer Druck erfassen
            </button>
            <div className="space-y-3">
              {prints.map(print => (
                <div key={print.id} onClick={() => openEditModal(print)} className="bg-white p-4 rounded-lg shadow-sm border border-gray-100 relative hover:shadow-md transition cursor-pointer group">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {print.success ? <CheckCircle size={16} className="text-green-500"/> : <XCircle size={16} className="text-red-500"/>}
                        <h3 className="font-bold text-lg">{print.name}</h3>
                      </div>
                      <div className="text-sm text-gray-500 mt-1 flex flex-wrap gap-3">
                        <span className="flex items-center gap-1"><Clock size={12}/> {formatDuration(print.duration)}</span>
                        <span className="flex items-center gap-1"><Scale size={12}/> {print.weight}g</span>
                        <span>{new Date(print.date).toLocaleDateString()}</span>
                      </div>
                      
                      {/* Tags */}
                      <div className="flex flex-wrap gap-1 mt-2">
                        {print.tags && print.tags.map(tag => (
                          <span key={tag} className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Tag size={10} /> {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                    
                    <div className="flex flex-col items-end gap-2">
                      <span className="font-mono bg-yellow-50 text-yellow-800 px-2 rounded border border-yellow-100">{print.rating}⭐</span>
                      <button onClick={(e) => { e.stopPropagation(); deletePrint(print); }} className="text-gray-300 hover:text-red-500 p-1">
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* --- FILAMENTS --- */}
        {activeTab === 'filaments' && (
          <div>
            <button onClick={addFilament} className="mb-4 bg-gray-200 px-4 py-2 rounded flex items-center gap-2 hover:bg-gray-300"><Plus size={16}/> Filament hinzufügen</button>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filaments.map(f => (
                <div key={f.id} className="bg-white p-4 rounded shadow border-l-4 border-blue-500">
                   <div className="flex justify-between">
                     <span className="font-bold">{f.name}</span>
                     <span className={`font-mono font-bold ${f.weight < 100 ? 'text-red-500' : 'text-green-600'}`}>{f.weight}g</span>
                   </div>
                   <div className="text-sm text-gray-500 mt-1">{f.brand} | {f.material}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* --- TAGS --- */}
        {activeTab === 'tags' && (
          <div className="bg-white p-6 rounded shadow">
             <h3 className="font-bold mb-4 flex items-center gap-2"><Tag/> Globales Tag Management</h3>
             <div className="flex flex-wrap gap-2">
               {availableTags.map(tag => (
                 <span key={tag} className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full flex items-center gap-2">
                   {tag}
                   <button onClick={() => handleDeleteGlobalTag(tag)} className="hover:text-red-600 bg-white rounded-full p-0.5"><X size={12}/></button>
                 </span>
               ))}
             </div>
             {availableTags.length === 0 && <p className="text-gray-400 italic">Noch keine Tags erstellt.</p>}
          </div>
        )}
      </main>

      {/* --- MODAL (CREATE / EDIT) --- */}
      {showModal && currentPrint && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">{currentPrint.id ? 'Druck bearbeiten' : 'Neuer Druck'}</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-800"><X size={24}/></button>
            </div>
            
            <div className="space-y-5">
              {/* Name & Datum */}
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Name des Drucks</label>
                  <input type="text" className="w-full border p-2 rounded focus:ring-2 ring-blue-500 outline-none" value={currentPrint.name} onChange={e => setCurrentPrint({...currentPrint, name: e.target.value})}/>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Datum</label>
                  <input type="date" className="w-full border p-2 rounded" value={currentPrint.date} onChange={e => setCurrentPrint({...currentPrint, date: e.target.value})}/>
                </div>
              </div>

              {/* Stats: Zeit & Gewicht */}
              <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-lg">
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Dauer (Minuten)</label>
                  <div className="flex items-center gap-2">
                    <Clock size={16} className="text-gray-400"/>
                    <input type="number" className="w-full border p-2 rounded" value={currentPrint.duration} onChange={e => setCurrentPrint({...currentPrint, duration: parseInt(e.target.value) || 0})}/>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Gewicht (Gramm)</label>
                  <div className="flex items-center gap-2">
                    <Scale size={16} className="text-gray-400"/>
                    <input type="number" className="w-full border p-2 rounded" value={currentPrint.weight} onChange={e => setCurrentPrint({...currentPrint, weight: parseFloat(e.target.value) || 0})}/>
                  </div>
                  {originalPrintState && (
                    <div className="text-xs mt-1 text-right">
                      Diff: {currentPrint.weight - originalPrintState.weight > 0 ? '+' : ''}{(currentPrint.weight - originalPrintState.weight).toFixed(1)}g
                    </div>
                  )}
                </div>
              </div>

              {/* Filament Auswahl */}
              <div>
                 <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Verwendetes Filament</label>
                 <select className="w-full border p-2 rounded bg-white" value={currentPrint.filamentId} onChange={e => setCurrentPrint({...currentPrint, filamentId: e.target.value})}>
                   {filaments.map(f => (
                     <option key={f.id} value={f.id}>{f.name} ({f.weight}g verfügbar)</option>
                   ))}
                 </select>
                 {/* Live Bestand Vorschau */}
                 {(() => {
                   const selFil = filaments.find(f => f.id == currentPrint.filamentId);
                   if(!selFil) return null;
                   const oldWeight = originalPrintState && originalPrintState.filamentId == selFil.id ? originalPrintState.weight : 0;
                   const newStock = selFil.weight + oldWeight - currentPrint.weight;
                   return (
                     <div className={`text-xs mt-1 flex items-center gap-1 ${newStock < 0 ? 'text-red-600 font-bold' : 'text-gray-500'}`}>
                       {newStock < 0 && <AlertTriangle size={12}/>}
                       Neuer Bestand nach Speichern: {newStock}g
                     </div>
                   )
                 })()}
              </div>

              {/* Tags & Rating */}
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Tags</label>
                <div className="flex gap-2 mb-2">
                  <input type="text" placeholder="Neuer Tag..." className="flex-1 border p-2 rounded text-sm" value={newTagInput} onChange={e => setNewTagInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddTag()}/>
                  <button onClick={handleAddTag} className="bg-blue-500 text-white px-3 rounded text-sm"><Plus size={16}/></button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {availableTags.map(tag => (
                    <button key={tag} onClick={() => {
                        const newTags = currentPrint.tags.includes(tag) 
                          ? currentPrint.tags.filter(t => t !== tag)
                          : [...currentPrint.tags, tag];
                        setCurrentPrint({...currentPrint, tags: newTags});
                    }} className={`px-2 py-1 rounded-full text-xs border ${currentPrint.tags.includes(tag) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}>
                      {tag}
                    </button>
                  ))}
                </div>
              </div>

              {/* Success & Rating */}
              <div className="flex justify-between items-center bg-gray-50 p-3 rounded">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" className="w-5 h-5" checked={currentPrint.success} onChange={e => setCurrentPrint({...currentPrint, success: e.target.checked})}/>
                  <span className="text-sm font-medium">Druck erfolgreich?</span>
                </label>
                <div className="flex items-center gap-1">
                  {[1,2,3,4,5].map(star => (
                    <button key={star} onClick={() => setCurrentPrint({...currentPrint, rating: star})} className={`text-xl ${star <= currentPrint.rating ? 'text-yellow-400' : 'text-gray-300'}`}>★</button>
                  ))}
                </div>
              </div>

              {/* Notizen */}
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase mb-1">Notizen</label>
                <textarea className="w-full border p-2 rounded h-20 text-sm" value={currentPrint.notes} onChange={e => setCurrentPrint({...currentPrint, notes: e.target.value})} placeholder="Einstellungen, Probleme, etc."/>
              </div>

              {/* Buttons */}
              <div className="flex justify-end gap-3 pt-4 border-t">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded">Abbrechen</button>
                <button onClick={handleSavePrint} className="px-6 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 shadow-lg transform active:scale-95 transition">
                  {currentPrint.id ? 'Änderungen Speichern' : 'Druck Speichern'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
