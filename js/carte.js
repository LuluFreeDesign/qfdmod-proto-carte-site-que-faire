/* ============================================================
   Prototype de carte — page « Que faire de mes meubles ? »

   Règles fonctionnelles reprises de la carte du MVP assistant V2 :
   - rafraîchissement des lieux de la zone visible après 1 s d'immobilité
   - plafond de 20 repères simultanés, repères stables (un lieu affiché
     garde sa place tant qu'il reste en vue)
   - zone visible > 60 km → aucun repère + bannière invitant à zoomer
     (pas d'appel API : l'échantillon serait trompeur)
   - cache LRU des réponses + mutualisation des requêtes en vol + retry
   - repère usager uniquement pour une adresse précise (jamais une commune)

   Filtres repris du scope testé et validé du prototype assistant :
   petit bouton avec badge compteur, panneau dépliable, tags supprimables.

   Données : open data ADEME « Acteurs de l'économie circulaire »,
   filtrées côté client sur la sous-catégorie « meuble » (page Meubles).
   ============================================================ */
(function () {
  'use strict';

  // =============================================
  // Constantes
  // =============================================

  const ACTEURS_API = 'https://data.ademe.fr/data-fair/api/v1/datasets/longue-vie-aux-objets-acteurs-de-leconomie-circulaire/lines';
  const ACTEURS_SELECT = 'nom,nom_commercial,adresse,complement_dadresse,code_postal,ville,latitude,longitude,type_dacteur,type_de_services,qualites_et_labels,reparer,donner,revendre,echanger,trier,horaires_description,horaires_osm,telephone,site_web,identifiant,description,uniquement_sur_rdv,reprise,exclusivite_de_reprisereparation,lieu_prestation,perimetreadomicile,paternite,date_de_derniere_modification';
  const ACTEURS_SIZE = '1000';         // plafond accepté par l'API data-fair
  const ACTEURS_CACHE_MAX = 12;        // éviction LRU du cache de réponses

  const SLUG_OBJET = 'meuble';         // page Meubles → sous-catégorie « meuble »

  const MAX_MAP_POINTS = 20;           // plafond de repères affichés simultanément
  const MAP_REFRESH_DELAY = 1000;      // ms d'immobilité avant de rafraîchir la zone
  const MAP_ZONE_MAX_KM = 60;          // au-delà : zone trop vaste, aucun repère
  const RAYON_RECHERCHE_KM = 20;       // rayon de la recherche initiale (adresse / commune)

  const MSG_AUCUN_LIEU = 'Aucun lieu trouvé avec ces critères ici. Déplacez la carte ou modifiez les filtres.';
  // Vue Liste sans résultat : les deux chemins d'entrée sont proposés, l'adresse
  // n'étant pas le seul moyen de trouver des lieux (on peut aussi explorer la carte).
  const MSG_LISTE_VIDE = 'Saisissez une adresse, ou explorez la carte pour voir des lieux.';
  const SOLUTIONS_PAR_PAGE = 10;
  const MSG_ZONE_TROP_VASTE = 'Zoomez sur la carte et faites-la défiler, ou cherchez une adresse pour voir apparaître des points.';

  // Vue initiale : France métropolitaine entière
  const FRANCE_CENTER = [2.6, 46.8];
  const FRANCE_ZOOM = 5.1;

  // Légende des gestes : libellés demandés, icônes fournies, champs API associés
  const GESTES = [
    { key: 'reparer', label: 'Je répare', icon: 'img/geste-reparer.svg', fields: ['reparer'] },
    { key: 'donner', label: 'Je donne, j’échange', icon: 'img/geste-donner.svg', fields: ['donner', 'echanger'] },
    { key: 'vendre', label: 'Je vends', icon: 'img/geste-vendre.svg', fields: ['revendre'] },
    { key: 'deposer', label: 'Je dépose en point de collecte', icon: 'img/geste-deposer.svg', fields: ['trier'] },
  ];

  // Priorité d'action pour choisir le pin d'un lieu multi-gestes
  const MARKER_PRIORITY = ['reparer', 'revendre', 'echanger', 'donner', 'trier'];

  const ACTION_LABELS = {
    reparer: 'Réparer',
    donner: 'Donner',
    revendre: 'Revendre',
    echanger: 'Échanger',
    trier: 'Déposer',
  };

  const TYPE_ACTEUR_LABELS = {
    ess: 'Association / ESS',
    artisan: 'Artisan',
    commerce: 'Commerce',
    pav_public: 'Point de collecte',
    decheterie: 'Déchèterie',
    service_public: 'Service public',
    collectivite: 'Collectivité',
  };

  const TYPE_SERVICE_LABELS = {
    structure_de_collecte: 'Structure de collecte',
    service_de_reparation: 'Service de réparation',
    achat_revente_particuliers: 'Achat-revente entre particuliers',
    achat_revente_professionnel: 'Achat-revente professionnel',
    recyclerie: 'Recyclerie',
    depot_vente: 'Dépôt-vente',
    atelier_pour_reparer_soi_meme: 'Atelier pour réparer soi-même',
    relai_acteurs_et_evenements: 'Relai d’acteurs et événements',
    don_particuliers: 'Don entre particuliers',
    echanges_particuliers: 'Échanges entre particuliers',
    espace_de_partage: 'Espace de partage',
    localtion_particuliers: 'Location entre particuliers',
    location_professionnel: 'Location professionnelle',
    partage_particuliers: 'Partage entre particuliers',
    pieces_detachees: 'Pièces détachées',
    structure_qui_sous_traite_la_reparation: 'Structure qui sous-traite la réparation',
    tutoriels_et_diagnostics_en_ligne: 'Tutoriels et diagnostics en ligne',
  };

  // =============================================
  // Pins (repris du MVP assistant V2)
  // =============================================

  const PIN_REPARATION = '<svg width="28" height="38" viewBox="0 0 35 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M28.6676 31.0249C32.5362 27.8096 35 22.9574 35 17.5287C35 7.84786 27.165 0 17.5 0C7.83502 0 0 7.84786 0 17.5287C0 22.9542 2.4609 27.804 6.32565 31.0192L10.2164 35.0734C13.4986 38.4934 16.0433 42.553 17.6923 47C19.2133 42.5564 21.6616 38.4882 24.8741 35.0659L28.6676 31.0249Z" fill="#009081"/><path d="M11.8605 8.47997C12.9869 8.07887 14.293 8.32983 15.1945 9.23287C16.0963 10.1362 16.3468 11.4448 15.9458 12.5733L25.8521 22.4958L23.9144 24.4367L14.0071 14.5146C12.8807 14.9157 11.5747 14.6647 10.6731 13.7617C9.77129 12.8584 9.52085 11.5497 9.92178 10.4213L11.9649 12.4677C12.5 13.0037 13.3676 13.0037 13.9027 12.4677C14.4378 11.9318 14.4378 11.0628 13.9027 10.5268L11.8605 8.47997ZM21.3307 10.2033L24.2374 8.58589L25.5292 9.87984L23.9144 12.7912L22.2995 13.1147L20.3618 15.0557L19.07 13.7617L21.0077 11.8208L21.3307 10.2033ZM14.8716 17.32L16.8093 19.261L12.2879 23.7898C11.7528 24.3258 10.8852 24.3258 10.3502 23.7898C9.84653 23.2854 9.81691 22.4859 10.2613 21.9468L10.3502 21.8489L14.8716 17.32Z" fill="white"/></svg>';

  const PIN_DON = '<svg width="28" height="38" viewBox="0 0 35 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M28.6676 30.3648C32.5362 27.2179 35 22.4689 35 17.1557C35 7.68088 27.165 0 17.5 0C7.83502 0 0 7.68088 0 17.1557C0 22.4658 2.4609 27.2124 6.32565 30.3593L10.2164 34.3272C13.4986 37.6744 16.0433 41.6476 17.6923 46C19.2133 41.651 21.6616 37.6693 24.8741 34.3198L28.6676 30.3648Z" fill="white"/><path d="M17.4997 0C27.1646 0 35.0001 7.68075 35.0002 17.1555C35.0002 22.4686 32.5359 27.2176 28.6672 30.3644L24.8744 34.3199C21.662 37.6692 19.2135 41.6507 17.6924 45.9996C16.0434 41.6474 13.4981 37.6744 10.2161 34.3273L6.3254 30.3592C2.46075 27.2123 0 22.4655 0 17.1555C0.000141758 7.68083 7.83496 0.000138961 17.4997 0ZM17.4997 2.28492C9.12221 2.28506 2.33091 8.94276 2.33077 17.1555C2.33077 21.6136 4.32922 25.6125 7.50368 28.3413L7.81475 28.6016L7.91566 28.6835L11.8966 32.7438C14.1474 35.0391 16.0725 37.6107 17.6287 40.3877C19.113 37.6161 20.9777 35.0474 23.1764 32.755L26.9692 28.7995L27.0686 28.6968L27.1794 28.6061C30.5371 25.8748 32.6695 21.7601 32.6695 17.1555C32.6693 8.94267 25.8774 2.28492 17.4997 2.28492Z" fill="#417DC4"/><path d="M15.3404 15.2394L17.1004 15.2398C19.1162 15.2398 20.7502 16.8417 20.7502 18.8178L15.0719 18.8171L15.0727 19.6129L21.5613 19.6123V18.8178C21.5613 17.9571 21.3032 17.1456 20.8426 16.4318L23.1834 16.4324C24.7993 16.4324 26.1945 17.3589 26.8463 18.6996C24.9283 21.1809 21.8224 22.7934 18.317 22.7934C16.0774 22.7934 14.1801 22.3238 12.6391 21.5015L12.6403 14.1035C13.6505 14.2454 14.575 14.6479 15.2233 15.2394H15.3404ZM11.0173 13.252C11.4333 13.252 11.7761 13.5589 11.823 13.9543L11.8284 14.0464V21.2031C11.8284 21.6423 11.4653 21.9983 11.0173 21.9983H9.39518C8.94724 21.9983 8.58411 21.6423 8.58411 21.2031V14.0471C8.58411 13.6079 8.94724 13.252 9.39518 13.252H11.0173Z" fill="#417DC4"/></svg>';

  const PIN_VENTE = '<svg width="28" height="38" viewBox="0 0 35 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M28.6676 31.0249C32.5362 27.8096 35 22.9574 35 17.5287C35 7.84786 27.165 0 17.5 0C7.83502 0 0 7.84786 0 17.5287C0 22.9542 2.4609 27.804 6.32565 31.0192L10.2164 35.0734C13.4986 38.4934 16.0433 42.553 17.6923 47C19.2133 42.5564 21.6616 38.4882 24.8741 35.0659L28.6676 31.0249Z" fill="white"/><path d="M17.4997 0C27.1646 0 35.0001 7.84772 35.0002 17.5284C35.0002 22.9571 32.5359 27.8093 28.6672 31.0245L24.8744 35.066C21.662 38.4881 19.2135 42.5562 17.6924 46.9996C16.0434 42.5527 13.4981 38.4934 10.2161 35.0736L6.3254 31.0192C2.46075 27.8039 0 22.9538 0 17.5284C0.000141758 7.84781 7.83496 0.000141982 17.4997 0ZM17.4997 2.33459C9.12221 2.33473 2.33091 9.13717 2.33077 17.5284C2.33077 22.0835 4.32922 26.1693 7.50368 28.9574L7.81475 29.2234L7.91566 29.307L11.8966 33.4556C14.1474 35.8009 16.0725 38.4283 17.6287 41.2657C19.113 38.4339 20.9777 35.8093 23.1764 33.467L26.9692 29.4256L27.0686 29.3207L27.1794 29.228C30.5371 26.4373 32.6695 22.2332 32.6695 17.5284C32.6693 9.13708 25.8774 2.33459 17.4997 2.33459Z" fill="#BB8568"/><path d="M17.5061 25.6562C13.0266 25.6562 9.39532 22.019 9.39532 17.5322C9.39532 13.0455 13.0266 9.4082 17.5061 9.4082C21.9855 9.4082 25.6168 13.0455 25.6168 17.5322C25.6168 22.019 21.9855 25.6562 17.5061 25.6562ZM17.5061 24.0314C21.0896 24.0314 23.9947 21.1216 23.9947 17.5322C23.9947 13.9428 21.0896 11.033 17.5061 11.033C13.9225 11.033 11.0175 13.9428 11.0175 17.5322C11.0175 21.1216 13.9225 24.0314 17.5061 24.0314ZM15.9245 16.7198H19.9393V18.3446H15.9245C16.1123 19.2717 16.9306 19.9694 17.9116 19.9694C18.4106 19.9694 18.8674 19.789 19.2206 19.4895L20.6002 20.4108C19.9331 21.1383 18.9755 21.5942 17.9116 21.5942C16.0329 21.5942 14.4858 20.1725 14.284 18.3446H13.4507V16.7198H14.284C14.4858 14.8919 16.0329 13.4702 17.9116 13.4702C18.9755 13.4702 19.9331 13.9262 20.6002 14.6537L19.2207 15.575C18.8675 15.2755 18.4106 15.095 17.9116 15.095C16.9306 15.095 16.1123 15.7928 15.9245 16.7198Z" fill="#BB8568"/></svg>';

  const PIN_TRI = '<svg width="28" height="38" viewBox="0 0 35 47" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M28.6676 31.0249C32.5362 27.8096 35 22.9574 35 17.5287C35 7.84786 27.165 0 17.5 0C7.83502 0 0 7.84786 0 17.5287C0 22.9542 2.4609 27.804 6.32565 31.0192L10.2164 35.0734C13.4986 38.4934 16.0433 42.553 17.6923 47C19.2133 42.5564 21.6616 38.4882 24.8741 35.0659L28.6676 31.0249Z" fill="white"/><path d="M17.4997 0C27.1646 0 35.0001 7.84772 35.0002 17.5284C35.0002 22.9571 32.5359 27.8093 28.6672 31.0245L24.8744 35.066C21.662 38.4881 19.2135 42.5562 17.6924 46.9996C16.0434 42.5527 13.4981 38.4934 10.2161 35.0736L6.3254 31.0192C2.46075 27.8039 0 22.9538 0 17.5284C0.000141758 7.84781 7.83496 0.000141982 17.4997 0ZM17.4997 2.33459C9.12221 2.33473 2.33091 9.13717 2.33077 17.5284C2.33077 22.0835 4.32922 26.1693 7.50368 28.9574L7.81475 29.2234L7.91566 29.307L11.8966 33.4556C14.1474 35.8009 16.0725 38.4283 17.6287 41.2657C19.113 38.4339 20.9777 35.8093 23.1764 33.467L26.9692 29.4256L27.0686 29.3207L27.1794 29.228C30.5371 26.4373 32.6695 22.2332 32.6695 17.5284C32.6693 9.13708 25.8774 2.33459 17.4997 2.33459Z" fill="#A558A0"/><path d="M23.6347 17.6107L24.8768 19.7649C25.6607 21.1249 25.1955 22.8639 23.8378 23.6491C23.4062 23.8987 22.9167 24.03 22.4184 24.03L20.7458 24.0295V25.6548L16.6904 22.8114L20.7458 19.968V21.5923L22.4184 21.5928C22.4896 21.5928 22.5595 21.5741 22.6212 21.5384C22.7936 21.4387 22.8652 21.2313 22.8004 21.0501L22.7696 20.9835L21.5275 18.8294L23.6347 17.6107ZM14.0438 15.4055L14.4746 20.3451L13.0701 19.5329L12.2334 20.9835C12.1978 21.0453 12.1791 21.1153 12.1791 21.1866C12.1791 21.3861 12.3226 21.5519 12.5117 21.5862L12.5846 21.5928L15.0682 21.5925V24.0296L12.5846 24.03C11.0168 24.03 9.74589 22.757 9.74589 21.1866C9.74589 20.6875 9.87705 20.1972 10.1262 19.7649L10.9629 18.3143L9.55768 17.5016L14.0438 15.4055ZM18.9209 10.1939C19.3525 10.4435 19.7108 10.8024 19.96 11.2347L20.7958 12.6858L22.201 11.8731L21.7703 16.8126L17.2842 14.7166L18.6886 13.9044L17.8527 12.4533C17.8171 12.3915 17.7659 12.3403 17.7043 12.3046C17.5318 12.2049 17.3167 12.2464 17.1924 12.3933L17.1503 12.4533L15.9088 14.6078L13.8016 13.3892L15.0431 11.2347C15.827 9.8747 17.5632 9.40873 18.9209 10.1939Z" fill="#A558A0"/></svg>';

  const PIN_BONUS_REPARATION = '<svg width="34" height="42" viewBox="0 0 43 52" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M17.4996 4.95117C27.1645 4.95117 34.9999 12.786 35 22.4508C35 27.9209 32.4894 32.8044 28.5586 36.0135L24.8659 39.9527C21.6583 43.3743 19.2134 47.4378 17.6923 51.8743C16.0422 47.4317 13.5225 43.3622 10.2813 39.9049L7.14173 36.556C2.81111 33.3703 0 28.2392 0 22.4508C0.000141748 12.7861 7.83491 4.95131 17.4996 4.95117Z" fill="#009081"/><path d="M11.4068 14.4777C12.5331 14.0773 13.8392 14.3278 14.7407 15.2294C15.6426 16.1312 15.893 17.4377 15.4921 18.5643L25.3982 28.4705L23.4605 30.4083L13.5533 20.5024C12.427 20.9028 11.1209 20.6523 10.2194 19.7507C9.31756 18.8489 9.06712 17.5424 9.46804 16.4158L11.5112 18.4589C12.0463 18.994 12.9138 18.994 13.4489 18.4589C13.984 17.9238 13.984 17.0563 13.4489 16.5212L11.4068 14.4777ZM20.8769 16.1982L23.7835 14.5835L25.0753 15.8753L23.4605 18.7819L21.8457 19.1048L19.908 21.0426L18.6162 19.7507L20.5539 17.813L20.8769 16.1982ZM14.4178 23.3032L16.3555 25.241L11.8341 29.7624C11.2991 30.2975 10.4315 30.2975 9.89641 29.7624C9.3928 29.2588 9.36318 28.4606 9.80753 27.9224L9.89641 27.8246L14.4178 23.3032Z" fill="white"/><circle cx="33" cy="10" r="5" fill="#3A3A3A"/><path d="M34.6217 1.74566C33.6873 0.94936 32.313 0.949369 31.3786 1.74565L30.2553 2.70295C30.1218 2.81669 29.9559 2.88543 29.781 2.89938L28.3098 3.01679C27.086 3.11444 26.1143 4.08622 26.0166 5.30999L25.8992 6.78122C25.8853 6.95602 25.8165 7.12201 25.7028 7.25548L24.7455 8.37882C23.9492 9.31324 23.9492 10.6875 24.7455 11.6218L25.7028 12.7452C25.8165 12.8787 25.8852 13.0447 25.8992 13.2195L26.0166 14.6907C26.1143 15.9144 27.0861 16.8862 28.3098 16.9838L29.7811 17.1013C29.9559 17.1152 30.1218 17.184 30.2552 17.2977L31.3786 18.255C32.313 19.0512 33.6873 19.0513 34.6217 18.255L35.7451 17.2977C35.8785 17.184 36.0444 17.1152 36.2192 17.1012L37.6905 16.9838C38.9142 16.8862 39.886 15.9145 39.9837 14.6907L40.1011 13.2195C40.115 13.0447 40.1838 12.8787 40.2975 12.7452L41.2548 11.6219C42.0511 10.6875 42.0511 9.31315 41.2548 8.37882L40.2975 7.25544C40.1837 7.12197 40.1151 6.95602 40.1011 6.78123L39.9837 5.30999C39.8861 4.08624 38.9142 3.11443 37.6905 3.01678L36.2192 2.89937C36.0444 2.88542 35.8785 2.81669 35.7451 2.70295L34.6217 1.74566ZM35.357 6.46489L36.5355 7.6434L30.6429 13.536L29.4644 12.3574L35.357 6.46489ZM31.5268 8.52724C31.0386 9.0154 30.2472 9.0154 29.759 8.52724C29.2709 8.03915 29.2709 7.24767 29.759 6.75951C30.2472 6.27135 31.0386 6.27135 31.5268 6.75951C32.015 7.24767 32.015 8.03915 31.5268 8.52724ZM34.4731 13.2413C33.9849 12.7532 33.9849 11.9617 34.4731 11.4736C34.9612 10.9854 35.7526 10.9854 36.2408 11.4736C36.729 11.9617 36.729 12.7532 36.2408 13.2413C35.7526 13.7295 34.9612 13.7295 34.4731 13.2413Z" fill="#EFCB3A"/></svg>';

  const PIN_USER = '<svg width="32" height="32" viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="25" cy="25" r="23.5" fill="white" stroke="#E1000F" stroke-width="3"/><path d="M33.4853 32.1512L25 40.6366L16.5147 32.1512C14.8365 30.473 13.6936 28.3348 13.2306 26.007C12.7676 23.6793 13.0052 21.2665 13.9135 19.0738C14.8217 16.8811 16.3598 15.0069 18.3332 13.6884C20.3066 12.3698 22.6266 11.666 25 11.666C27.3734 11.666 29.6934 12.3698 31.6668 13.6884C33.6402 15.0069 35.1783 16.8811 36.0865 19.0738C36.9948 21.2665 37.2324 23.6793 36.7694 26.007C36.3064 28.3348 35.1636 30.473 33.4853 32.1512ZM25 26.3326C25.7072 26.3326 26.3855 26.0516 26.8856 25.5515C27.3857 25.0514 27.6667 24.3732 27.6667 23.6659C27.6667 22.9587 27.3857 22.2804 26.8856 21.7803C26.3855 21.2802 25.7072 20.9992 25 20.9992C24.2928 20.9992 23.6145 21.2802 23.1144 21.7803C22.6143 22.2804 22.3333 22.9587 22.3333 23.6659C22.3333 24.3732 22.6143 25.0514 23.1144 25.5515C23.6145 26.0516 24.2928 26.3326 25 26.3326Z" fill="#E1000F"/></svg>';

  const PIN_BY_ACTION = {
    reparer: PIN_REPARATION,
    donner: PIN_DON,
    echanger: PIN_DON,
    revendre: PIN_VENTE,
    trier: PIN_TRI,
  };

  // =============================================
  // Filtres (scope testé et validé du prototype assistant)
  // =============================================

  const FILTER_DEFS = [
    { key: 'bonus', chipLabel: 'Bonus Réparation', reject: a => !isBonusReparation(a) },
    { key: 'ess', chipLabel: 'Économie sociale et solidaire', reject: a => a.type_dacteur !== 'ess' },
    { key: 'reparActeur', chipLabel: 'Répar’Acteurs', reject: a => !isReparActeur(a) },
    { key: 'hideExclusivite', chipLabel: 'Sans réparateurs de marque', reject: a => String(a.exclusivite_de_reprisereparation || '').toLowerCase() === 'oui' },
  ];

  // =============================================
  // État
  // =============================================

  const state = {
    gestes: { reparer: true, donner: true, vendre: true, deposer: true }, // légende : tout coché
    filters: { bonus: false, ess: false, reparActeur: false, hideExclusivite: true },
    selectedAddress: null,   // { lon, lat, label, type }
    acteurs: [],             // repères actuellement affichés
    vue: 'carte',            // 'carte' | 'liste' — vue active du sélecteur segmenté
    pageListe: 1,            // pagination de la vue Liste
  };

  let mapInstance = null;
  let mapMarkers = [];
  let userMarker = null;
  let _mapRefreshTimer = null;
  let _mapRefreshSeq = 0;
  let _lastBboxResults = [];   // derniers résultats bruts (pour re-filtrer sans re-fetch)
  // Vrai quand les repères sont mis de côté à cause d'un dézoom au-delà du seuil :
  // au retour sous le seuil, on les restitue tels quels sans nouvelle recherche.
  let _masquePourZoneVaste = false;

  // =============================================
  // Helpers génériques
  // =============================================

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function humanizeSlug(slug) {
    if (!slug) return '';
    return slug.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
  }

  function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m`;
    if (km < 10) return `${km.toFixed(1)} km`;
    return `${Math.round(km)} km`;
  }

  function formatDateFr(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
  }

  function isBonusReparation(acteur) {
    const haystack = (acteur.qualites_et_labels || '').toLowerCase();
    return haystack.includes('bonusrepar') || haystack.includes('qualirepar');
  }

  function isReparActeur(acteur) {
    const haystack = (acteur.qualites_et_labels || '').toLowerCase();
    return haystack.includes('reparacteur');
  }

  function lieuTypeServiceLabel(acteur) {
    const raw = acteur.type_de_services || '';
    const first = raw.split('|')[0].trim();
    return TYPE_SERVICE_LABELS[first] || (first ? humanizeSlug(first) : (TYPE_ACTEUR_LABELS[acteur.type_dacteur] || ''));
  }

  // =============================================
  // Réseau (règles MVP : cache LRU + inflight + retry + timeout)
  // =============================================

  const _acteursCache = new Map();
  const _inflightActeurs = new Map();

  async function fetchActeursUrl(url) {
    if (_acteursCache.has(url)) {
      const hit = _acteursCache.get(url);
      _acteursCache.delete(url);
      _acteursCache.set(url, hit);
      return hit;
    }
    if (_inflightActeurs.has(url)) return _inflightActeurs.get(url);

    const promise = (async () => {
      const delays = [0, 1500];
      let lastErr = null;
      for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) await new Promise(r => setTimeout(r, delays[i]));
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 10000);
        try {
          const resp = await fetch(url, { signal: ctrl.signal });
          clearTimeout(timeoutId);
          if (resp.ok) {
            const json = await resp.json();
            _acteursCache.set(url, json);
            if (_acteursCache.size > ACTEURS_CACHE_MAX) {
              _acteursCache.delete(_acteursCache.keys().next().value);
            }
            return json;
          }
          lastErr = new Error(`Erreur API ${resp.status}`);
          if (![502, 503, 504].includes(resp.status)) break;
        } catch (e) {
          clearTimeout(timeoutId);
          lastErr = e;
        }
      }
      throw lastErr || new Error('Erreur API');
    })();

    _inflightActeurs.set(url, promise);
    try {
      return await promise;
    } finally {
      _inflightActeurs.delete(url);
    }
  }

  // Recherche dans le rectangle visible (bornage des coordonnées : règle MVP)
  function fetchActeursBbox(west, south, east, north) {
    const r = (v, lim) => Math.round(Math.max(-lim, Math.min(lim, v)) * 10000) / 10000;
    const params = new URLSearchParams({
      bbox: `${r(west, 180)},${r(south, 90)},${r(east, 180)},${r(north, 90)}`,
      size: ACTEURS_SIZE,
      select: ACTEURS_SELECT,
    });
    return fetchActeursUrl(`${ACTEURS_API}?${params}`);
  }

  // Recherche autour d'un point, du plus proche au plus loin — utilisée pour la
  // recherche initiale (adresse ou commune). Sans paramètre `q`, l'API trie
  // nativement par distance croissante : les N premiers résultats sont donc
  // bien les N vrais plus proches.
  function fetchActeursProches(lat, lon, rayonKm) {
    // Arrondi à 4 décimales (~11 m) : stabilise la clé de cache
    const latR = Math.round(lat * 10000) / 10000;
    const lonR = Math.round(lon * 10000) / 10000;
    const params = new URLSearchParams({
      geo_distance: `${lonR},${latR},${rayonKm * 1000}`,
      size: ACTEURS_SIZE,
      select: ACTEURS_SELECT,
    });
    return fetchActeursUrl(`${ACTEURS_API}?${params}`);
  }

  // =============================================
  // Filtrage côté client (meuble + gestes cochés + filtres actifs)
  // =============================================

  // Champs d'action couverts par les gestes actuellement cochés dans la légende
  function checkedActionFields() {
    return GESTES.filter(g => state.gestes[g.key]).flatMap(g => g.fields);
  }

  // Vrai si le champ d'action de l'acteur concerne les meubles
  function fieldHasMeuble(acteur, field) {
    const val = acteur[field] || '';
    if (!val.trim()) return false;
    return val.split(' | ').map(s => s.trim()).includes(SLUG_OBJET);
  }

  // Un lieu est retenu s'il propose au moins un geste coché pour les meubles
  // et s'il passe les filtres actifs.
  function acteurMatches(acteur) {
    const fields = checkedActionFields();
    if (!fields.some(f => fieldHasMeuble(acteur, f))) return false;
    const f = state.filters;
    return FILTER_DEFS.every(def => !f[def.key] || !def.reject(acteur));
  }

  // Action retenue pour le pin : priorité MARKER_PRIORITY, restreinte aux
  // champs des gestes cochés qui concernent les meubles.
  function primaryActionFor(acteur) {
    const fields = checkedActionFields();
    for (const a of MARKER_PRIORITY) {
      if (fields.includes(a) && fieldHasMeuble(acteur, a)) return a;
    }
    return 'trier';
  }

  // Toutes les actions « meubles » du lieu (pour la fiche), gestes cochés ou non
  function meubleActions(acteur) {
    const all = ['reparer', 'donner', 'echanger', 'revendre', 'trier'];
    return all.filter(a => fieldHasMeuble(acteur, a));
  }

  // =============================================
  // Carte (règles MVP)
  // =============================================

  function visibleSpanKm(bounds) {
    const north = bounds.getNorth(), south = bounds.getSouth();
    const west = bounds.getWest(), east = bounds.getEast();
    const midLat = (north + south) / 2;
    return {
      width: haversineKm(midLat, west, midLat, east),
      height: haversineKm(south, west, north, west),
    };
  }

  function isZoneTropVaste(bounds) {
    const span = visibleSpanKm(bounds);
    return Math.max(span.width, span.height) >= MAP_ZONE_MAX_KM;
  }

  function acteurId(a) {
    return a.identifiant || `${a.latitude},${a.longitude},${a.nom || ''}`;
  }

  function isActeurInBounds(a, bounds) {
    const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
    if (isNaN(lat) || isNaN(lon)) return false;
    return lon >= bounds.getWest() && lon <= bounds.getEast()
      && lat >= bounds.getSouth() && lat <= bounds.getNorth();
  }

  // Règle MVP : un repère affiché garde sa place tant que son lieu reste en vue ;
  // les places libres vont aux lieux les plus proches du centre, max 20.
  function selectActeursForView(affiches, candidats, bounds, center) {
    const avecDistance = (a) => ({ ...a, _distance: haversineKm(
      center.lat, center.lng, parseFloat(a.latitude), parseFloat(a.longitude)) });

    const gardes = affiches
      .filter(a => isActeurInBounds(a, bounds))
      .filter(a => acteurMatches(a))
      .map(avecDistance);

    const dejaAffiches = new Set(gardes.map(acteurId));
    const nouveaux = candidats
      .filter(a => isActeurInBounds(a, bounds))
      .filter(a => acteurMatches(a))
      .filter(a => !dejaAffiches.has(acteurId(a)))
      .map(avecDistance)
      .sort((a, b) => a._distance - b._distance)
      .slice(0, Math.max(0, MAX_MAP_POINTS - gardes.length));

    return gardes.concat(nouveaux);
  }

  function setMapBanner(message) {
    const el = document.getElementById('carte-banner');
    if (!el) return;
    if (message) {
      // Composant DSFR « alerte > information », version petite (sans titre)
      el.innerHTML = `<div class="fr-alert fr-alert--info fr-alert--sm"><p>${escapeHtml(message)}</p></div>`;
      el.hidden = false;
    } else {
      el.innerHTML = '';
      el.hidden = true;
    }
  }

  function clearMapMarkers() {
    mapMarkers.forEach(m => m.remove());
    mapMarkers = [];
  }

  function createActeurMarkerEl(acteur) {
    const primary = primaryActionFor(acteur);
    const useBonus = primary === 'reparer' && isBonusReparation(acteur);
    const pinSvg = useBonus ? PIN_BONUS_REPARATION : (PIN_BY_ACTION[primary] || PIN_TRI);

    // Marqueur volontairement minimal : aucune transition (sinon elle
    // interpolerait le transform de position que MapLibre met à jour à chaque
    // frame et les repères « glisseraient »), ni agrandissement au survol.
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'carte-marker';
    el.setAttribute('aria-label', `Voir la fiche du lieu ${acteur.nom_commercial || acteur.nom || ''}`);
    el.innerHTML = pinSvg;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openLieu(acteur);
    });
    return el;
  }

  function renderUserMarker() {
    if (userMarker) { userMarker.remove(); userMarker = null; }
    // Règle MVP : jamais de repère usager pour une commune entière
    if (!state.selectedAddress || state.selectedAddress.type === 'municipality') return;
    const el = document.createElement('div');
    el.className = 'carte-user-marker';
    el.innerHTML = PIN_USER;
    userMarker = new maplibregl.Marker({ element: el })
      .setLngLat([state.selectedAddress.lon, state.selectedAddress.lat])
      .addTo(mapInstance);
  }

  function renderMarkers() {
    if (!mapInstance) return;
    clearMapMarkers();
    state.acteurs.forEach(a => {
      const lat = parseFloat(a.latitude), lon = parseFloat(a.longitude);
      if (isNaN(lat) || isNaN(lon)) return;
      const marker = new maplibregl.Marker({ element: createActeurMarkerEl(a), anchor: 'bottom' })
        .setLngLat([lon, lat])
        .addTo(mapInstance);
      mapMarkers.push(marker);
    });
    renderUserMarker();
    // La vue Liste montre toujours exactement la même sélection que la carte
    renderListe(state.acteurs);
  }

  async function refreshMapZone() {
    if (!mapInstance) return;
    const bounds = mapInstance.getBounds();
    const center = mapInstance.getCenter();
    const seq = ++_mapRefreshSeq;

    // Zone trop vaste (au-delà du niveau départemental) : aucun repère et aucun
    // appel API — l'échantillon renvoyé serait trompeur. Les lieux ne sont pas
    // perdus, seulement mis de côté dans state.acteurs. Le repère rouge de
    // l'adresse, lui, reste affiché même au-delà du seuil.
    if (isZoneTropVaste(bounds)) {
      _masquePourZoneVaste = true;
      clearMapMarkers();
      renderUserMarker();
      renderListe([]);   // les lieux sont mis de côté : la liste se vide aussi
      setMapBanner(MSG_ZONE_TROP_VASTE);
      return;
    }

    // Retour sous le seuil après un dézoom : on restitue exactement les lieux
    // mis de côté, sans aller en chercher de nouveaux.
    if (_masquePourZoneVaste) {
      _masquePourZoneVaste = false;
      const restaures = state.acteurs.filter(a => isActeurInBounds(a, bounds) && acteurMatches(a));
      if (restaures.length > 0) {
        state.acteurs = restaures;
        setMapBanner('');
        renderMarkers();
        return;
      }
      // Aucun lieu mis de côté dans cette zone : on repart sur une recherche normale
    }

    try {
      const data = await fetchActeursBbox(
        bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth());
      if (seq !== _mapRefreshSeq) return;

      _lastBboxResults = data.results || [];
      state.acteurs = selectActeursForView(state.acteurs, _lastBboxResults, bounds, center);
      setMapBanner(state.acteurs.length > 0 ? '' : MSG_AUCUN_LIEU);
      renderMarkers();
    } catch (err) {
      if (seq !== _mapRefreshSeq) return;
      console.error('[carte] refreshMapZone :', err);
    }
  }

  function scheduleMapZoneRefresh() {
    clearTimeout(_mapRefreshTimer);
    _mapRefreshTimer = setTimeout(refreshMapZone, MAP_REFRESH_DELAY);
  }

  // Recherche initiale, déclenchée par une adresse, une commune ou la
  // géolocalisation : les 20 lieux les plus proches dans un rayon de 20 km,
  // triés par distance, puis cadrage automatique de la carte sur ces lieux.
  // L'échelle obtenue s'adapte donc d'elle-même à la densité : quartier en
  // ville dense, intercommunalité en zone rurale.
  async function rechercheInitiale(lat, lon) {
    if (!mapInstance) return;
    const seq = ++_mapRefreshSeq;
    clearTimeout(_mapRefreshTimer);
    _masquePourZoneVaste = false;

    try {
      const data = await fetchActeursProches(lat, lon, RAYON_RECHERCHE_KM);
      if (seq !== _mapRefreshSeq) return;

      const acteurs = (data.results || [])
        .filter(a => acteurMatches(a))
        .map(a => ({ ...a, _distance: haversineKm(
          lat, lon, parseFloat(a.latitude), parseFloat(a.longitude)) }))
        .filter(a => !isNaN(a._distance))
        .sort((a, b) => a._distance - b._distance)
        .slice(0, MAX_MAP_POINTS);

      state.acteurs = acteurs;
      _lastBboxResults = data.results || [];

      // Cadrage sur les lieux trouvés + le point recherché. fitBounds est un
      // déplacement programmatique : il ne relance pas de recherche (seul un
      // geste de l'usager le fait), les repères restent donc ceux-ci.
      const bounds = new maplibregl.LngLatBounds();
      bounds.extend([lon, lat]);
      acteurs.forEach(a => bounds.extend([parseFloat(a.longitude), parseFloat(a.latitude)]));
      if (!bounds.isEmpty()) {
        mapInstance.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 0 });
      }

      setMapBanner(acteurs.length > 0 ? '' : MSG_AUCUN_LIEU);
      renderMarkers();
    } catch (err) {
      if (seq !== _mapRefreshSeq) return;
      console.error('[carte] rechercheInitiale :', err);
    }
  }

  // Ré-applique légende + filtres sur les données déjà chargées, puis complète
  // via un rafraîchissement de zone (utile après cache).
  function applyFiltersNow() {
    if (!mapInstance) return;
    const bounds = mapInstance.getBounds();
    const center = mapInstance.getCenter();
    if (isZoneTropVaste(bounds)) return;   // la bannière « zoomez » reste en place
    state.acteurs = selectActeursForView(state.acteurs, _lastBboxResults, bounds, center);
    setMapBanner(state.acteurs.length > 0 ? '' : MSG_AUCUN_LIEU);
    renderMarkers();
    scheduleMapZoneRefresh();
  }

  function initMap() {
    if (mapInstance) return;

    // Style « désaturé » de Carte Facile (IGN / DINUM)
    const cf = window.CarteFacile && CarteFacile.mapStyles;
    const style = (cf && (cf.desaturated || cf.desature || cf.gris))
      || (cf && cf.simple)
      || 'https://tiles.openfreemap.org/styles/positron';

    mapInstance = new maplibregl.Map({
      container: 'carte-map',
      style,
      center: FRANCE_CENTER,
      zoom: FRANCE_ZOOM,
      maxZoom: 18.9,
      attributionControl: false,
    });
    // Légende à gauche → contrôles de navigation à droite
    mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapInstance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    // Geste utilisateur uniquement (e.originalEvent) : un fitBounds/flyTo
    // programmatique ne relance pas de recherche (règle MVP).
    mapInstance.on('moveend', (e) => {
      if (!e.originalEvent) return;
      scheduleMapZoneRefresh();
    });

    mapInstance.on('load', () => {
      refreshMapZone();   // vue France entière → bannière « zoomez »
    });
  }

  // =============================================
  // Vue Liste (pendant de la vue Carte, comme l'assistant V2)
  // =============================================

  // Distance affichée seulement si une adresse est connue : après une simple
  // exploration de la carte, _distance vaut la distance au centre de la vue et
  // non à l'usager — l'afficher serait trompeur.
  function distanceDepuisAdresse(acteur) {
    if (!state.selectedAddress) return null;
    const km = haversineKm(
      state.selectedAddress.lat, state.selectedAddress.lon,
      parseFloat(acteur.latitude), parseFloat(acteur.longitude));
    return isNaN(km) ? null : km;
  }

  // Pastille de geste colorée (colonne « Actions ») : couleurs et icônes reprises
  // de la légende, pour une lecture cohérente entre la carte et le tableau.
  const ACTION_PILL = {
    reparer:  { label: 'Réparer',  cls: 'reparer', icon: 'img/geste-reparer.svg' },
    donner:   { label: 'Donner',   cls: 'donner',  icon: 'img/geste-donner.svg' },
    echanger: { label: 'Échanger', cls: 'donner',  icon: 'img/geste-donner.svg' },
    revendre: { label: 'Vendre',   cls: 'vendre',  icon: 'img/geste-vendre.svg' },
    trier:    { label: 'Déposer',  cls: 'deposer', icon: 'img/geste-deposer.svg' },
  };

  // Une ligne <tr> du tableau des lieux
  function renderListeRangee(acteur) {
    const nom = acteur.nom_commercial || acteur.nom || 'Lieu sans nom';
    const km = distanceDepuisAdresse(acteur);
    const id = escapeHtml(acteurId(acteur));

    const badges = [];
    if (isBonusReparation(acteur)) badges.push('<p class="fr-badge fr-badge--sm fr-badge--yellow-tournesol">Bonus Réparation</p>');
    if (isReparActeur(acteur)) badges.push('<p class="fr-badge fr-badge--sm fr-badge--green-menthe">Répar’Acteurs</p>');
    if (acteur.type_dacteur === 'ess') badges.push('<p class="fr-badge fr-badge--sm fr-badge--blue-cumulus">Économie sociale et solidaire</p>');

    const pills = meubleActions(acteur).map(a => {
      const p = ACTION_PILL[a] || { label: ACTION_LABELS[a] || humanizeSlug(a), cls: 'deposer', icon: 'img/geste-deposer.svg' };
      return `<span class="carte-pill carte-pill--${p.cls}"><img src="${p.icon}" alt="" aria-hidden="true">${p.label}</span>`;
    }).join('');

    return `
      <tr>
        <td>
          <button type="button" class="carte-liste__nom" data-carte-lieu-id="${id}">${escapeHtml(nom)}</button>
          ${badges.length ? `<div class="carte-liste__badges fr-badges-group fr-badges-group--sm">${badges.join('')}</div>` : ''}
        </td>
        <td>${pills ? `<div class="carte-liste__pills">${pills}</div>` : ''}</td>
        <td class="carte-liste__distance">${km !== null ? formatDistance(km) : '—'}</td>
        <td class="carte-liste__voir-cell">
          <button type="button" class="fr-link fr-link--sm" data-carte-lieu-id="${id}">Voir la fiche</button>
        </td>
      </tr>`;
  }

  function renderPagination(total, page) {
    const pages = Math.ceil(total / SOLUTIONS_PAR_PAGE);
    if (pages <= 1) return '';
    let items = `<li><a class="fr-pagination__link fr-pagination__link--prev" href="#" data-page="${page - 1}"
                    ${page === 1 ? 'aria-disabled="true" role="link"' : ''}>Précédent</a></li>`;
    for (let p = 1; p <= pages; p++) {
      items += `<li><a class="fr-pagination__link" href="#" data-page="${p}"
                   ${p === page ? 'aria-current="page"' : ''}>${p}</a></li>`;
    }
    items += `<li><a class="fr-pagination__link fr-pagination__link--next" href="#" data-page="${page + 1}"
                 ${page === pages ? 'aria-disabled="true" role="link"' : ''}>Suivant</a></li>`;
    return `<nav class="fr-pagination" role="navigation" aria-label="Pagination des lieux">
              <ul class="fr-pagination__list">${items}</ul>
            </nav>`;
  }

  // Rend la vue Liste à partir des lieux passés (par défaut ceux affichés sur la
  // carte) : les deux vues montrent donc toujours exactement la même sélection.
  function renderListe(acteurs) {
    const el = document.getElementById('carte-liste');
    if (!el) return;
    const liste = (acteurs || state.acteurs || []).slice();

    if (liste.length === 0) {
      state.pageListe = 1;
      el.innerHTML = `<p class="carte-liste__vide">${MSG_LISTE_VIDE}</p>`;
      return;
    }

    // Tri par distance à l'adresse quand elle est connue, sinon on conserve
    // l'ordre de sélection (déjà trié par distance au centre de la vue).
    if (state.selectedAddress) {
      liste.sort((a, b) => (distanceDepuisAdresse(a) ?? 0) - (distanceDepuisAdresse(b) ?? 0));
    }

    const pages = Math.max(1, Math.ceil(liste.length / SOLUTIONS_PAR_PAGE));
    if (state.pageListe > pages) state.pageListe = pages;
    const debut = (state.pageListe - 1) * SOLUTIONS_PAR_PAGE;
    const rangees = liste.slice(debut, debut + SOLUTIONS_PAR_PAGE).map(renderListeRangee).join('');

    const n = liste.length;
    const caption = `${n} lieu${n > 1 ? 'x' : ''} du plus proche au plus loin`;

    el.innerHTML = `
      <div class="fr-table fr-table--sm carte-liste__table">
        <table>
          <caption>${caption}</caption>
          <thead>
            <tr>
              <th scope="col">Nom du lieu</th>
              <th scope="col">Actions</th>
              <th scope="col">Distance</th>
              <th scope="col"><span class="fr-sr-only">Consulter la fiche</span></th>
            </tr>
          </thead>
          <tbody>${rangees}</tbody>
        </table>
      </div>
      ${renderPagination(liste.length, state.pageListe)}`;

    // Ouverture de la fiche depuis le nom ou le lien « Voir la fiche »
    el.querySelectorAll('[data-carte-lieu-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cible = liste.find(a => acteurId(a) === btn.dataset.carteLieuId);
        if (cible) openLieu(cible);
      });
    });

    // Pagination
    el.querySelectorAll('.fr-pagination__link[data-page]').forEach(lien => {
      lien.addEventListener('click', (e) => {
        e.preventDefault();
        if (lien.getAttribute('aria-disabled') === 'true') return;
        const p = parseInt(lien.dataset.page, 10);
        if (!isNaN(p) && p >= 1 && p <= pages) {
          state.pageListe = p;
          renderListe(acteurs);
          el.scrollTop = 0;
        }
      });
    });
  }

  // Bascule Carte / Liste
  function setVue(vue) {
    state.vue = vue;
    const mapWrap = document.getElementById('carte-map-wrap');
    const liste = document.getElementById('carte-liste');
    if (!mapWrap || !liste) return;
    const surCarte = vue === 'carte';
    mapWrap.hidden = !surCarte;
    liste.hidden = surCarte;
    // Le canvas masqué perd ses dimensions : on le recale au retour sur la carte
    if (surCarte && mapInstance) setTimeout(() => mapInstance.resize(), 50);
    if (!surCarte) renderListe();
  }

  // =============================================
  // Fiche lieu (au clic sur un pin — comme le MVP)
  // =============================================

  function openLieu(acteur) {
    const lieuEl = document.getElementById('carte-lieu');
    const mapWrap = document.getElementById('carte-map-wrap');
    const topbar = document.getElementById('carte-topbar');
    const chips = document.getElementById('carte-chips');
    if (!lieuEl) return;

    const liste = document.getElementById('carte-liste');
    lieuEl.innerHTML = renderLieuContent(acteur);
    lieuEl.hidden = false;
    mapWrap.hidden = true;
    if (liste) liste.hidden = true;
    topbar.hidden = true;
    chips.hidden = true;
    lieuEl.scrollTop = 0;

    // Accordéons : câblés à la main (l'analyse DSFR n'atteint pas ce contenu injecté)
    lieuEl.querySelectorAll('.fr-accordion__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = document.getElementById(btn.getAttribute('aria-controls'));
        const expanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', String(!expanded));
        if (target) target.classList.toggle('fr-collapse--expanded', !expanded);
      });
    });

    lieuEl.querySelector('[data-carte-retour]').addEventListener('click', () => {
      lieuEl.hidden = true;
      topbar.hidden = false;
      chips.hidden = false;
      // On revient sur la vue qui était active avant l'ouverture de la fiche
      setVue(state.vue);
    });
  }

  function renderLieuContent(acteur) {
    const nom = acteur.nom_commercial || acteur.nom || 'Lieu sans nom';
    const service = lieuTypeServiceLabel(acteur);
    let dist = '';
    if (state.selectedAddress) {
      const km = haversineKm(state.selectedAddress.lat, state.selectedAddress.lon,
        parseFloat(acteur.latitude), parseFloat(acteur.longitude));
      if (!isNaN(km)) dist = formatDistance(km);
    }
    const meta = [service, dist].filter(Boolean).join(' · ');

    // Badges : Bonus Réparation en priorité (règle MVP), puis labels secondaires
    const badges = [];
    if (isBonusReparation(acteur)) badges.push('<p class="fr-badge fr-badge--yellow-tournesol fr-badge--sm">Propose le Bonus Réparation</p>');
    if (isReparActeur(acteur)) badges.push('<p class="fr-badge fr-badge--green-menthe fr-badge--sm">Répar’Acteurs</p>');
    if (acteur.type_dacteur === 'ess') badges.push('<p class="fr-badge fr-badge--blue-cumulus fr-badge--sm">Économie sociale et solidaire</p>');

    // Gestes proposés pour les meubles
    const gestes = meubleActions(acteur)
      .map(a => `<p class="fr-tag fr-tag--sm">${ACTION_LABELS[a] || humanizeSlug(a)}</p>`)
      .join('');

    // Adresse et contact
    const line1 = [acteur.adresse, acteur.complement_dadresse].filter(Boolean).join(', ');
    const line2 = [acteur.code_postal, acteur.ville].filter(Boolean).join(' ');
    const contactRows = [];
    if (line1 || line2) {
      contactRows.push(`<p class="carte-lieu__line">${line1 ? escapeHtml(line1) : ''}${line1 && line2 ? '<br>' : ''}${line2 ? escapeHtml(line2) : ''}</p>`);
    }
    if (acteur.telephone) {
      contactRows.push(`<p class="carte-lieu__line"><strong>Téléphone :</strong> ${escapeHtml(acteur.telephone)}</p>`);
    }
    if (acteur.site_web) {
      let display = acteur.site_web;
      try { display = new URL(acteur.site_web).hostname.replace(/^www\./, ''); } catch (e) { /* URL invalide : on garde le texte brut */ }
      contactRows.push(`<p class="carte-lieu__line"><strong>Site web :</strong> <a href="${escapeHtml(acteur.site_web)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a></p>`);
    }

    // Informations pratiques (textes du MVP)
    const infos = [];
    if (isBonusReparation(acteur)) infos.push('Ce lieu propose le Bonus Réparation.');
    const presta = (acteur.lieu_prestation || '').toLowerCase();
    const perim = (acteur.perimetreadomicile || '').toString().trim();
    if (presta.includes('domicile') || perim) infos.push('Ce lieu propose des services à domicile.');
    if (String(acteur.uniquement_sur_rdv || '').toLowerCase() === 'oui') infos.push('Les services de cet établissement ne sont disponibles que sur rendez-vous.');
    if (String(acteur.exclusivite_de_reprisereparation || '').toLowerCase() === 'oui') infos.push('Ce lieu ne répare que les produits de ses marques.');
    if (String(acteur.reprise || '').trim() === '1 pour 1') infos.push('Ce lieu ne reprend vos objets que dans le cadre d’un achat neuf.');

    // Accordéons DSFR : description, horaires, en savoir plus
    const description = (acteur.description || '').trim();
    const horaires = (acteur.horaires_description || acteur.horaires_osm || '').trim();
    const sources = (acteur.paternite || '').split('|').map(s => s.trim()).filter(Boolean);
    const typeEnseigne = TYPE_ACTEUR_LABELS[acteur.type_dacteur] || (acteur.type_dacteur ? humanizeSlug(acteur.type_dacteur) : '');
    const labels = (acteur.qualites_et_labels || '').split('|').map(s => s.trim()).filter(Boolean);

    const uid = Math.random().toString(36).slice(2, 8);
    const accordions = [];
    if (description) {
      accordions.push(`
        <section class="fr-accordion">
          <h4 class="fr-accordion__title">
            <button type="button" class="fr-accordion__btn" aria-expanded="false" aria-controls="lieu-acc-desc-${uid}">Description</button>
          </h4>
          <div class="fr-collapse" id="lieu-acc-desc-${uid}"><p>${escapeHtml(description).replace(/\n+/g, '<br>')}</p></div>
        </section>`);
    }
    if (horaires) {
      accordions.push(`
        <section class="fr-accordion">
          <h4 class="fr-accordion__title">
            <button type="button" class="fr-accordion__btn" aria-expanded="false" aria-controls="lieu-acc-horaires-${uid}">Horaires</button>
          </h4>
          <div class="fr-collapse" id="lieu-acc-horaires-${uid}"><p>${escapeHtml(horaires).replace(/\n+/g, '<br>')}</p></div>
        </section>`);
    }
    if (sources.length || typeEnseigne || labels.length) {
      const sourcesHtml = sources.length ? `<h5 class="fr-text--sm fr-mb-1v">Sources</h5><ul class="fr-mb-2w">${sources.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : '';
      const typeHtml = typeEnseigne ? `<h5 class="fr-text--sm fr-mb-1v">Type d’enseigne</h5><p class="fr-mb-2w">${escapeHtml(typeEnseigne)}</p>` : '';
      const labelsHtml = labels.length ? `<h5 class="fr-text--sm fr-mb-1v">Labels</h5><ul>${labels.map(l => `<li>${escapeHtml(humanizeSlug(l))}</li>`).join('')}</ul>` : '';
      accordions.push(`
        <section class="fr-accordion">
          <h4 class="fr-accordion__title">
            <button type="button" class="fr-accordion__btn" aria-expanded="false" aria-controls="lieu-acc-plus-${uid}">En savoir plus sur ce lieu</button>
          </h4>
          <div class="fr-collapse" id="lieu-acc-plus-${uid}">${sourcesHtml}${typeHtml}${labelsHtml}</div>
        </section>`);
    }

    const dateMaj = acteur.date_de_derniere_modification ? formatDateFr(acteur.date_de_derniere_modification) : '';

    return `
      <div class="carte-lieu__back">
        <button type="button" class="fr-link fr-icon-arrow-left-line fr-link--icon-left" data-carte-retour>Retour à la carte</button>
      </div>
      ${badges.length ? `<div class="fr-badges-group fr-badges-group--sm fr-mb-1w">${badges.join('')}</div>` : ''}
      <h3 class="carte-lieu__name">${escapeHtml(nom)}</h3>
      ${meta ? `<p class="carte-lieu__meta">${escapeHtml(meta)}</p>` : ''}
      ${gestes ? `<div class="carte-lieu__gestes fr-tags-group fr-tags-group--sm">${gestes}</div>` : ''}
      ${contactRows.length ? `<h4 class="carte-lieu__section-title">Adresse et contact</h4>${contactRows.join('')}` : ''}
      ${infos.length ? `<ul class="carte-lieu__infos">${infos.map(t => `<li>${t}</li>`).join('')}</ul>` : ''}
      ${accordions.length ? `<h4 class="carte-lieu__section-title">Description et services détaillés</h4><div class="fr-accordions-group">${accordions.join('')}</div>` : ''}
      ${dateMaj ? `<p class="carte-lieu__update">Mise à jour le ${dateMaj}</p>` : ''}
    `;
  }

  // =============================================
  // Légende flottante (gauche)
  // =============================================

  function renderLegende() {
    const items = GESTES.map(g => `
      <div class="fr-fieldset__element">
        <div class="fr-checkbox-group fr-checkbox-group--sm">
          <input type="checkbox" id="legende-${g.key}" ${state.gestes[g.key] ? 'checked' : ''} data-geste="${g.key}">
          <label class="fr-label" for="legende-${g.key}">
            <span class="carte-legende__item">
              <img class="carte-legende__icone" src="${g.icon}" alt="" aria-hidden="true">
              <span>${g.label}</span>
            </span>
          </label>
        </div>
      </div>`).join('');

    return `
      <div class="carte-legende">
        <button type="button" class="fr-btn fr-btn--tertiary-no-outline fr-btn--sm fr-icon-arrow-up-s-line fr-btn--icon-right carte-legende__toggle"
                aria-expanded="true" aria-controls="carte-legende-body" id="carte-legende-toggle">
          Légende
        </button>
        <div class="carte-legende__body" id="carte-legende-body">
          <fieldset class="fr-fieldset" aria-label="Gestes affichés sur la carte">
            ${items}
          </fieldset>
        </div>
      </div>`;
  }

  function wireLegende(root) {
    const toggle = root.querySelector('#carte-legende-toggle');
    const body = root.querySelector('#carte-legende-body');
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.hidden = expanded;
    });
    root.querySelectorAll('[data-geste]').forEach(input => {
      input.addEventListener('change', () => {
        state.gestes[input.dataset.geste] = input.checked;
        applyFiltersNow();
      });
    });
  }

  // =============================================
  // Filtres : bouton compact + panneau + tags supprimables
  // =============================================

  function renderFilters() {
    return `
      <div class="carte-app__filter-wrap">
        <button type="button" class="fr-btn fr-btn--tertiary fr-btn--sm fr-icon-filter-line fr-btn--icon-left"
                id="carte-filter-btn" aria-expanded="false" aria-controls="carte-filters-panel">
          Filtres
        </button>
        <span class="carte-app__filter-badge" id="carte-filter-badge" hidden></span>
        <div class="carte-app__filters-panel" id="carte-filters-panel" hidden>
          <p class="carte-app__filters-title">Filtrer les solutions</p>
          <fieldset class="fr-fieldset" aria-label="Filtres">
            <div class="fr-fieldset__element">
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input type="checkbox" id="carte-filter-bonus" data-filter="bonus">
                <label class="fr-label" for="carte-filter-bonus">
                  <img class="carte-app__filter-icone" src="img/icon-bonus-reparation.svg" alt="" aria-hidden="true">
                  Lieux proposant le Bonus Réparation
                  <span class="fr-hint-text">Uniquement les acteurs proposant le Bonus Réparation.</span>
                </label>
              </div>
            </div>
            <div class="fr-fieldset__element">
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input type="checkbox" id="carte-filter-ess" data-filter="ess">
                <label class="fr-label" for="carte-filter-ess">
                  <img class="carte-app__filter-icone" src="img/icon-ess.svg" alt="" aria-hidden="true">
                  Lieux de l’économie sociale et solidaire
                  <span class="fr-hint-text">Afficher uniquement les adresses recensées comme relevant de l’économie sociale et solidaire. <a href="https://www.economie.gouv.fr/economie-sociale-et-solidaire-ess" target="_blank" rel="noopener noreferrer">En savoir plus sur economie.gouv.fr</a>.</span>
                </label>
              </div>
            </div>
            <div class="fr-fieldset__element">
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input type="checkbox" id="carte-filter-reparacteur" data-filter="reparActeur">
                <label class="fr-label" for="carte-filter-reparacteur">
                  <img class="carte-app__filter-icone" src="img/icon-reparacteur.svg" alt="" aria-hidden="true">
                  Lieux labellisés Répar’Acteurs
                  <span class="fr-hint-text">Afficher uniquement les artisans labellisés. Les Répar’Acteurs sont une initiative de <a href="https://www.artisanat.fr/nous-connaitre/vous-accompagner/reparacteurs" target="_blank" rel="noopener noreferrer">la Chambre des Métiers et de l’Artisanat</a>.</span>
                </label>
              </div>
            </div>
          </fieldset>
          <hr class="carte-app__filters-separator">
          <fieldset class="fr-fieldset" aria-label="Autres options">
            <div class="fr-fieldset__element">
              <div class="fr-checkbox-group fr-checkbox-group--sm">
                <input type="checkbox" id="carte-filter-exclusivite" data-filter="hideExclusivite" checked>
                <label class="fr-label" for="carte-filter-exclusivite">Masquer les lieux qui réparent uniquement les produits de leurs marques
                  <span class="fr-hint-text">Les adresses ne réparant que les produits de leur propre marque n’apparaîtront pas si cette case est cochée.</span>
                </label>
              </div>
            </div>
          </fieldset>
        </div>
      </div>`;
  }

  function updateFilterChips(root) {
    const chips = root.querySelector('#carte-chips');
    // Chips supprimables pour les filtres « inclusion » actifs (pattern validé :
    // pas de chip pour « masquer exclusivité », mais compté dans le badge)
    const active = FILTER_DEFS.filter(def => def.key !== 'hideExclusivite' && state.filters[def.key]);
    chips.innerHTML = active.map(def => `
      <button type="button" class="fr-tag fr-tag--sm fr-tag--dismiss" data-chip="${def.key}"
              aria-label="Retirer le filtre ${escapeHtml(def.chipLabel)}">${escapeHtml(def.chipLabel)}</button>`).join('');
    chips.querySelectorAll('[data-chip]').forEach(btn => {
      btn.addEventListener('click', () => {
        setFilter(root, btn.dataset.chip, false);
      });
    });

    const badge = root.querySelector('#carte-filter-badge');
    const count = FILTER_DEFS.filter(def => state.filters[def.key]).length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  function setFilter(root, key, checked) {
    state.filters[key] = checked;
    const input = root.querySelector(`[data-filter="${key}"]`);
    if (input) input.checked = checked;
    updateFilterChips(root);
    applyFiltersNow();
  }

  function wireFilters(root) {
    const btn = root.querySelector('#carte-filter-btn');
    const panel = root.querySelector('#carte-filters-panel');
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      panel.hidden = expanded;
    });
    // Clic en dehors : referme le panneau
    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      }
    });
    root.querySelectorAll('[data-filter]').forEach(input => {
      input.addEventListener('change', () => setFilter(root, input.dataset.filter, input.checked));
    });
    updateFilterChips(root);
  }

  // =============================================
  // Recherche d'adresse + géolocalisation
  // =============================================

  function renderAddressSearch() {
    return `
      <div class="carte-app__address">
        <label class="fr-label carte-app__address-label" for="carte-address-input">Où souhaitez-vous trouver des solutions&nbsp;?</label>
        <div class="fr-search-bar" role="search">
          <input class="fr-input" placeholder="ex : 1 rue Simone Veil 93140 Bondy" type="search"
                 id="carte-address-input" autocomplete="off">
          <button type="button" class="fr-btn" title="Rechercher">Rechercher</button>
        </div>
        <ul class="carte-app__address-results" id="carte-address-results" role="listbox" aria-label="Suggestions d’adresses"></ul>
      </div>`;
  }

  function goToAddress(feature) {
    const [lon, lat] = feature.geometry.coordinates;
    // « type » vaut municipality pour une commune : dans ce cas, pas de repère
    // rouge (ce n'est pas une adresse précise) — cf. renderUserMarker.
    const type = feature.properties.type || '';
    state.selectedAddress = { lon, lat, label: feature.properties.label, type };
    rechercheInitiale(lat, lon);
  }

  function wireAddressSearch(root) {
    const input = root.querySelector('#carte-address-input');
    const list = root.querySelector('#carte-address-results');
    let debounceTimer = null;

    function closeList() { list.innerHTML = ''; }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 3) { closeList(); return; }
      debounceTimer = setTimeout(async () => {
        try {
          const resp = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=5&autocomplete=1`);
          if (!resp.ok) return;
          const json = await resp.json();
          const feats = json.features || [];
          list.innerHTML = feats.map((f, i) => `
            <li role="option"><button type="button" data-idx="${i}">
              ${escapeHtml(f.properties.label)}
              <span class="fr-hint-text">${escapeHtml(f.properties.context || '')}</span>
            </button></li>`).join('');
          list.querySelectorAll('button[data-idx]').forEach(btn => {
            btn.addEventListener('click', () => {
              const f = feats[parseInt(btn.dataset.idx, 10)];
              input.value = f.properties.label;
              closeList();
              goToAddress(f);
            });
          });
        } catch (e) { /* réseau silencieux : la saisie reste possible */ }
      }, 300);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeList();
    });
    document.addEventListener('click', (e) => {
      if (!list.contains(e.target) && e.target !== input) closeList();
    });
  }

  function wireGeoloc(root) {
    const btn = root.querySelector('#carte-geoloc-btn');
    const input = root.querySelector('#carte-address-input');

    // Géocodage inverse : renseigne le champ adresse avec le lieu obtenu, pour
    // que l'usager voie sur quoi porte la recherche (comme l'assistant V2).
    async function renseigneAdresse(lat, lon) {
      try {
        const resp = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lon=${lon}&lat=${lat}`);
        if (!resp.ok) return;
        const json = await resp.json();
        const f = (json.features || [])[0];
        if (f && input) input.value = f.properties.label;
      } catch (e) { /* échec silencieux : la carte reste utilisable */ }
    }

    btn.addEventListener('click', () => {
      if (!navigator.geolocation) return;
      btn.disabled = true;
      btn.classList.add('carte-app__geoloc--chargement');
      const fin = () => {
        btn.disabled = false;
        btn.classList.remove('carte-app__geoloc--chargement');
      };
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          fin();
          state.selectedAddress = {
            lon: pos.coords.longitude,
            lat: pos.coords.latitude,
            label: 'Ma position',
            type: 'geoloc',   // position précise → repère rouge affiché
          };
          renseigneAdresse(state.selectedAddress.lat, state.selectedAddress.lon);
          rechercheInitiale(state.selectedAddress.lat, state.selectedAddress.lon);
        },
        fin,
        { enableHighAccuracy: false, timeout: 8000 }
      );
    });
  }

  // =============================================
  // Application : montage + responsive + modale
  // =============================================

  function buildApp() {
    const app = document.createElement('div');
    app.className = 'carte-app';
    app.id = 'carte-app';
    app.innerHTML = `
      <div class="carte-app__topbar" id="carte-topbar">
        ${renderAddressSearch()}
        <div class="carte-app__actions">
          <fieldset class="fr-segmented fr-segmented--sm" id="carte-vue-segmented">
            <legend class="fr-segmented__legend fr-sr-only">Affichage des résultats</legend>
            <div class="fr-segmented__elements">
              <div class="fr-segmented__element">
                <input value="carte" type="radio" id="carte-vue-carte" name="carte-vue" checked>
                <label class="fr-label fr-icon-map-pin-2-line" for="carte-vue-carte">Carte</label>
              </div>
              <div class="fr-segmented__element">
                <input value="liste" type="radio" id="carte-vue-liste" name="carte-vue">
                <label class="fr-label fr-icon-list-unordered" for="carte-vue-liste">Liste</label>
              </div>
            </div>
          </fieldset>
          ${renderFilters()}
        </div>
      </div>
      <div class="carte-app__chips" id="carte-chips"></div>
      <div class="carte-liste" id="carte-liste" hidden></div>
      <div class="carte-app__map-wrap" id="carte-map-wrap">
        <div class="carte-app__map" id="carte-map"></div>
        ${renderLegende()}
        <p class="carte-app__banner" id="carte-banner" hidden></p>
        <button type="button" class="fr-btn fr-btn--sm carte-app__geoloc"
                id="carte-geoloc-btn" title="Me localiser" aria-label="Me localiser">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2 4.5 20.29l.71.71L12 18l6.79 3 .71-.71L12 2Z"/></svg>
        </button>
      </div>
      <div class="carte-lieu" id="carte-lieu" hidden></div>
    `;
    wireLegende(app);
    wireFilters(app);
    wireAddressSearch(app);
    wireGeoloc(app);
    app.querySelectorAll('input[name="carte-vue"]').forEach(radio => {
      radio.addEventListener('change', () => { if (radio.checked) setVue(radio.value); });
    });
    return app;
  }

  function init() {
    const slotDesktop = document.getElementById('carte-slot-desktop');
    const slotMobile = document.getElementById('carte-slot-mobile');
    if (!slotDesktop || !slotMobile) return;

    const app = buildApp();
    const mq = window.matchMedia('(min-width: 48em)');

    function placeApp() {
      const target = mq.matches ? slotDesktop : slotMobile;
      if (app.parentNode !== target) {
        target.appendChild(app);
        if (mapInstance) setTimeout(() => mapInstance.resize(), 50);
      }
    }

    placeApp();
    mq.addEventListener('change', placeApp);

    // Desktop : la carte s'initialise quand elle approche du viewport
    if (mq.matches) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) {
          observer.disconnect();
          initMap();
        }
      }, { rootMargin: '200px' });
      observer.observe(app);
    }

    // Mobile : la carte s'initialise à l'ouverture de la modale
    const modal = document.getElementById('fr-modal-carte');
    if (modal) {
      // Ouverture/fermeture gérées à la main (classe custom, hors du moteur
      // DSFR qui s'approprie les .fr-modal de façon imprévisible sur cette
      // page). Échap + verrouillage du scroll inclus.
      function openModal() {
        modal.classList.add('carte-modal--ouverte');
        document.body.style.overflow = 'hidden';
        if (!mapInstance) {
          initMap();
        } else {
          setTimeout(() => mapInstance.resize(), 100);
        }
      }
      function closeModal() {
        modal.classList.remove('carte-modal--ouverte');
        document.body.style.overflow = '';
      }
      const openBtn = document.getElementById('carte-open-btn');
      if (openBtn) openBtn.addEventListener('click', openModal);
      const closeBtn = document.getElementById('carte-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', closeModal);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('carte-modal--ouverte')) closeModal();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Poignée de debug pour le prototype (inspection en console)
  window.__carteDebug = {
    state,
    getMap: () => mapInstance,
    refreshMapZone,
    lastResults: () => _lastBboxResults.length,
  };
})();
