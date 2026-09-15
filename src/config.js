// Supabase-configuratie voor inloggen (zie SPEC_ACCOUNTS_AND_SAVING.md).
//
// De "anon" publieke sleutel hieronder is bedoeld om in de frontend te
// staan — dat is hoe de Supabase-SDK werkt. Hij geeft op zichzelf geen
// toegang tot data; row-level security in de database bepaalt wat een
// (al dan niet ingelogde) gebruiker mag lezen of schrijven.
//
// Zet hier NOOIT de "service role"-sleutel — die omzeilt row-level
// security volledig en hoort nergens in frontend-code thuis.
//
// Leeg laten (zoals hieronder) betekent: inloggen staat uit, de rest
// van de app werkt gewoon anoniem door.
window.SUPABASE_CONFIG = {
  url: 'https://tcxmkmbupbknklwiijoq.supabase.co',
  anonKey: 'sb_publishable_IfhXai-_KQiHnf2tNcXeLQ_k2FsUaN0',
};
